import Fastify,{FastifyRequest, FastifyReply} from 'fastify';
import fastifyJwt from '@fastify/jwt';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import path from 'path';

import { prisma } from './lib/prisma';
import { error } from 'node:console';

import { Bucket$, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { s3Client } from './lib/s3';
import { randomUUID } from 'node:crypto';

import { mediaQueue } from './lib/queue';
import { initCleanupJobs } from './lib/cleanup';

import { setupRealtimeEvents } from './lib/events';
import websocketPlugin from '@fastify/websocket';

dotenv.config()

const app=Fastify({logger:true});
initCleanupJobs();

app.register(fastifyJwt,{
    secret: process.env.JWT_SECRET||"fallback_secret" 
});

declare module '@fastify/jwt'{
    interface FastifyJWT{
        payload:{userId:string,email:string}
        user:{userId:string, email:string}
    }
}

app.decorate('authenticate',async (request:FastifyRequest,reply:FastifyReply)=>{
    try{
        await request.jwtVerify();
    }catch(err){
        return reply.code(401).send({err:"Invalid Credentials"});
    }
});

app.post('/api/v1/auth/signup', async (request,reply)=>{
    const {email,password}=request.body as {email?:string,password?:string};
    if(!email||!password||password.length<6){
        return reply.code(400).send({error:"Email and password(length>=6) is mandatory"});
    }
    const existingUser=await prisma.user.findUnique({where:{email}});
    if(existingUser){
        return reply.code(409).send({error:"User with this email already exists"});
    }
    const passwordHash=await bcrypt.hash(password,10);
    const user=await prisma.user.create({
        data:{email,passwordHash},
        select:{id:true,email:true,createdAt:true}
    })
    const token=app.jwt.sign({userId:user.id, email:user.email},{expiresIn:"24h"});
    return reply.code(200).send({
        user:{userId:user.id, email:user.email, createdAt:user.createdAt},
        token,
    })
});

app.post('/api/v1/auth/login', async (request,reply)=>{
    const {email,password}=request.body as {email?:string, password?:string};
    if(!email || !password){
        return reply.code(400).send({error:"Email and password is mandatory"});
    }
    const existUser=await prisma.user.findUnique({where:{email}});
    if(!existUser){
        return reply.code(401).send({error:"Invalid Credentials"});
    }
    const isValid=await bcrypt.compare(password,existUser.passwordHash);
    if(!isValid){
        return reply.code(401).send({error:"Invalid Credentials"});
    }
    const token=app.jwt.sign({userId:existUser.id,email:existUser.email},{expiresIn:"24h"});
    return reply.code(200).send({
        user:{userId:existUser.id,email:existUser.email,createdAt:existUser.createdAt},
        token,
    })
});

app.get('/api/v1/me',{onRequest:[async (request,reply)=>app.authenticate(request,reply)]},async (request,reply)=>{
    const user=await prisma.user.findUnique({
        where:{id:request.user.userId},
        select:{id:true,email:true,createdAt:true}
    })
    return reply.code(200).send(user);
});

const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];
const ALLOWED_MIME_TYPES=['image/jpeg','image/png','image/webp'];
const MAX_FILE_SIZE_BYTES=20*1024*1024;
const MAX_USER_STORAGE_BYTES=500*1024*1024;
const BUCKET_NAME=process.env.RAW_MEDIA_BUCKET||"raw-media-bucket";

app.post('/api/v1/files/upload-url',
    {onRequest:[async (request,reply)=> app.authenticate(request,reply)]},
    async (request,reply)=>{
        const { originalName, mimeType, sizeBytes}=request.body as {originalName:string, mimeType:string, sizeBytes:number}
        if(!originalName || !mimeType || !sizeBytes){
            return reply.code(400).send({error:"Missing file metadeta"});
        }
        const fileExt = path.extname(originalName).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(fileExt)) {
            return reply.code(400).send({
                error: `Forbidden extension '${fileExt}'. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
            });
        }
        if(!ALLOWED_MIME_TYPES.includes(mimeType)){
            return reply.code(400).send({
                error:`Unsupported format: ${mimeType}. Allowed formats: ${ALLOWED_MIME_TYPES.join(', ')}`
            })
        }

        const isJpegMismatch = (fileExt === '.jpg' || fileExt === '.jpeg') && mimeType !== 'image/jpeg';
        const isPngMismatch = fileExt === '.png' && mimeType !== 'image/png';
        const isWebpMismatch = fileExt === '.webp' && mimeType !== 'image/webp';

        if (isJpegMismatch || isPngMismatch || isWebpMismatch) {
            return reply.code(400).send({ error: 'File extension does not match the provided MIME type' });
        }

        if(sizeBytes>MAX_FILE_SIZE_BYTES){
            return reply.code(400).send({
                error:`File size exceeds the limit of ${MAX_FILE_SIZE_BYTES/(1024*1024)} MB`,
            })
        }

        const userId=request.user.userId;
        const userStorageUsage= await prisma.file.aggregate({
            where:{
                userId,
                status:{in:['PENDING','COMPLETED','PROCESSING']}
            },
            _sum:{
                sizeBytes: true,
            }
        })
        const currentUsage=Number(userStorageUsage._sum.sizeBytes||0);
        if((currentUsage+sizeBytes)>MAX_USER_STORAGE_BYTES){
            return reply.code(400).send({
                error:`Storage quota excedded. Used: ${(currentUsage/(1024*1024)).toFixed(2)} MB. Limit: ${(MAX_USER_STORAGE_BYTES/(1024*1024))} MB`,
            })
        }

        const fileextension=originalName.split(".").pop();
        const storageKey=`uploads/${userId}/${randomUUID()}.${fileextension}`;

        const fileRecord=await prisma.file.create({
            data:{
                userId,
                originalName,
                storageKey,
                mimeType,
                sizeBytes,
                status: 'PENDING',
            },
        });

        const cmnd=new PutObjectCommand({
            Bucket:BUCKET_NAME,
            Key:storageKey,
            ContentType:mimeType,
            ContentLength:sizeBytes,
        });

        const uploadUrl=await getSignedUrl(s3Client,cmnd,{expiresIn:900});

        return reply.code(200).send({
            fileId: fileRecord.id,
            url: uploadUrl,
            storageKey: storageKey
        })
    }
);

app.post('/api/v1/files/complete',
    {onRequest:[async (request,reply)=> app.authenticate(request,reply)]},
    async (request,reply) =>{
        const {fileId}=request.body as {fileId:string};
        const file=await prisma.file.findFirst({
            where:{id:fileId, userId:request.user.userId }
        });

        if(!file){
            return reply.code(404).send({ error: 'File record not found' });
        }
        const updatedFile=await prisma.file.update({
            where:{id:fileId},
            data:{status:'PROCESSING'},
        });
        await mediaQueue.add('process-media', {
            fileId: file.id,
            userId: file.userId,
            storageKey: file.storageKey,
            mimeType: file.mimeType,
        },{
            attempts:3,
            backoff:{
                type:'exponential',
                delay: 5000,
            },
            removeOnFail:false
        });
        return reply.code(200).send({
            message:'Upload confirmed, Processing queued',
            file:{
                ...updatedFile,
                sizeBytes: updatedFile.sizeBytes.toString(),
            }
        });
    }
);

const PROCESSED_BUCKET=process.env.PROCESSED_MEDIA_BUCKET||'processed-media-bucket';
app.get('/api/v1/files/:id/download',
    {onRequest:[ async (request,reply)=>app.authenticate(request,reply)]},
    async (request,reply)=>{
        const {id}=request.params as {id:string};
        const userId=request.user.userId;

        const file=await prisma.file.findFirst({
            where:{
                id,
                userId,
            }
        })
        if(!file){
            return reply.code(404).send({ error: 'File not found or access denied' });
        }
        if (file.status !== 'COMPLETED') {
            return reply.code(400).send({ 
                error: `File is not ready for download. Current status: ${file.status}` 
            });
        }

        const storageKey=`processed/${userId}/${file.id}/display.webp`;
        const cmnd=new GetObjectCommand({
            Bucket: PROCESSED_BUCKET,
            Key: storageKey
        })
        const downloadUrl=await getSignedUrl(s3Client,cmnd,{expiresIn:3600});
        return reply.send({
            fileId: file.id,
            originalName:file.originalName,
            downloadUrl,
            expiresInSeconds:3600,
        });
    }
);


const start=async ()=>{
    try{
        await app.register(websocketPlugin);
        setupRealtimeEvents(app);

        const port=Number(process.env.PORT)||3000;
        await app.listen({port,host:'0.0.0.0'});
        console.log(`Server running on http://localhost:${port}`);
    }catch(err){
        app.log.error(err);
        process.exit(1);
    }
}
start();