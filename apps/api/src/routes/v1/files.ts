import { FastifyInstance } from 'fastify';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { prisma } from '../../lib/prisma';
import { s3Client } from '../../lib/s3';
import { mediaQueue } from '../../lib/queue';

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MAX_USER_STORAGE_BYTES = 500 * 1024 * 1024;
const BUCKET_NAME = process.env.RAW_MEDIA_BUCKET || 'raw-media-bucket';
const PROCESSED_BUCKET = process.env.PROCESSED_MEDIA_BUCKET || 'processed-media-bucket';

export async function fileRoutes(app:FastifyInstance){
    app.post('/upload-url',{preHandler:[app.authenticate]},async (request,reply)=>{
        const {originalName,mimeType,sizeBytes}=request.body as {originalName?:string,mimeType?:string,sizeBytes?:number};
        if(!originalName||!mimeType||!sizeBytes){
            return reply.code(400).send({error:"Mising file metadata"});
        }

        const fileExt=path.extname(originalName).toLowerCase();
        if(!ALLOWED_EXTENSIONS.includes(fileExt)||!ALLOWED_MIME_TYPES.includes(mimeType)){
            return reply.send(400).send({error:"Forbidden extension or unsupported MIME type"});
        }
        if(sizeBytes>MAX_FILE_SIZE_BYTES){
            return reply.code(400).send({error:`File size exceeds ${MAX_FILE_SIZE_BYTES/(1024*1024)} MB`});
        }

        const userId=request.user.userId;
        const userStorageUsage=await prisma.file.aggregate({
            where:{userId,status: {in:['COMPLETED','PENDING','PROCESSING']}},
            _sum:{sizeBytes:true}
        });
        const currentUsage = Number(userStorageUsage._sum.sizeBytes || 0);
        if (currentUsage + sizeBytes > MAX_USER_STORAGE_BYTES) {
            return reply.code(400).send({ error: 'Storage quota exceeded' });
        }
        const fileExtension=originalName.split('.').pop();
        const storageKey=`uploads/${userId}/${randomUUID()}.${fileExtension}`;
        const fileRecord=await prisma.file.create({
            data:{userId,originalName,storageKey,mimeType,sizeBytes,status:'PENDING'}
        });
        const uploadUrl=await getSignedUrl(
            s3Client,
            new PutObjectCommand({Bucket:BUCKET_NAME,Key:storageKey,ContentType:mimeType,ContentLength:sizeBytes}),
            {expiresIn:900}
        )
        return reply.code(200).send({ fileId: fileRecord.id, url: uploadUrl, storageKey });
    });
    app.post('/complete',{preHandler:[app.authenticate,app.verifyFileOwnership]},async (request,reply)=>{
        const file=request.targetFile;
        if(!file){
            return reply.code(404).send({error: "File not found"});
        }
        if(file?.status==='COMPLETED'||file?.status==='PROCESSING'){
            return reply.code(200).send({
                msg: file.status === 'COMPLETED' ? 'File is already processed' : 'File is under processing',
                ...file,
                sizeBytes: file.sizeBytes.toString(),
            });
        }
        if (file.status === 'FAILED') {
            return reply.code(400).send({ error: 'Cannot trigger completion on a failed file' });
        }
        const updatedFile = await prisma.file.update({
            where: { id: file.id },
            data: { status: 'PROCESSING' },
        });
        await mediaQueue.add(
            'process-media',
            {fileId:file?.id,userId:file?.userId,storageKey:file?.storageKey,mimeType:file?.mimeType},
            {jobId:`media-job-${file?.id}`,attempts:3,backoff:{type:'exponential',delay:5000},removeOnFail:{age: 7 * 24 * 60 * 60}},
        )
        return reply.code(200).send({
            message: 'Upload confirmed, Processing queued',
            file: { ...updatedFile, sizeBytes: updatedFile.sizeBytes.toString() },
        });
    });
    app.get('/:id/download',{preHandler:[app.authenticate,app.verifyFileOwnership,]},async (request,reply)=>{
        const file=request.targetFile;
        if(!file){
            return reply.code(404).send({error: "File not found"});
        }
        if(file?.status!=='COMPLETED'){
            return reply.code(400).send({ error: `File is not ready for download. Current status: ${file.status}` });
        }
        const storageKey = `processed/${file.userId}/${file.id}/display.webp`;
        const downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: PROCESSED_BUCKET, Key: storageKey }), {
            expiresIn: 3600,
        });
        return reply.send({ fileId: file.id, originalName: file.originalName, downloadUrl, expiresInSeconds: 3600 });
    });
}