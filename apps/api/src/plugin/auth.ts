import { FastifyRequest,FastifyReply,FastifyPluginAsync } from "fastify";
import fastifyJwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import { prisma } from '../lib/prisma';


declare module 'fastify'{
    interface FastifyInstance{
        authenticate:(request:FastifyRequest,reply:FastifyReply)=>Promise<void>;
        verifyFileOwnership: (request:FastifyRequest,reply:FastifyReply)=>Promise<void>;
    }
    interface FastifyRequest{
        userContext?:{
            userId:string;
            email:string;
        };
        targetFile?:{
            id:string,
            userId:string,
            originalName:string
            status:string,
            storageKey:string,
            mimeType:string,
            sizeBytes:bigint,
        }
    }
}
const authPlugin:FastifyPluginAsync = async (fastify)=>{
    await fastify.register(fastifyJwt, {
        secret: process.env.JWT_SECRET || 'fallback_secret',
    });
    fastify.decorate('authenticate',async (request: FastifyRequest ,reply:FastifyReply)=>{
        try{
            await request.jwtVerify();
            request.userContext={
                userId:request.user.userId,
                email:request.user.email,
            }
        }catch(error){
            return reply.code(401).send({error:'Unauthorized: Inavlid or expired token'});
        }
    });

    fastify.decorate('verifyFileOwnership',async (request:FastifyRequest,reply:FastifyReply)=>{
        const userId=request.userContext?.userId;
        if(!userId){
            return reply.code(401).send({error:"Unauthenticated"});
        }
        const body=request.body as {fileId?:string}|undefined
        const params=request.params as {fileId?:string, id?:string}|undefined
        const fileId=body?.fileId||params?.fileId||params?.id;
        if(!fileId){
            return reply.code(400).send({error:"File Id required for ownership check"});
        }
        const file=await prisma.file.findUnique({
            where:{id:fileId},
            select:{id:true,userId:true,originalName:true,status:true,storageKey:true,mimeType:true,sizeBytes:true},
        });
        if(!file||file.userId!==userId){
            return reply.code(404).send({error:"File Record not found or access denied"});
        }
        request.targetFile=file;
    });
}

export default fp(authPlugin);