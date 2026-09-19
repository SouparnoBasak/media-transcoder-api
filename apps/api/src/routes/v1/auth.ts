import { FastifyInstance } from "fastify";
import bcrypt from 'bcrypt';
import { prisma } from "../../lib/prisma";

export async function authRoute(app:FastifyInstance){
    app.post('/signup',async (request,reply)=>{
        const {email,password}=request.body as {email?:string, password?:string};
        if(!email||!password||password.length<6){
            return reply.code(400).send({error:"Email and password(minimum6 characters) is mandatory"})
        }
        const existingUser=await prisma.user.findUnique({
            where:{email:email}
        });
        if(existingUser){
            return reply.code(409).send({error:"User with this email alread exists"});
        }
        const passwordHash=await bcrypt.hash(password,10);
        const user=await prisma.user.create({
            data:{email,passwordHash},
            select:{id:true,email:true,createdAt:true},
        });
        
        const token=app.jwt.sign({userId:user.id,email:user.email},{expiresIn:'24h'});
        return reply.code(200).send({user:{userId:user.id,email:user.email,createdAt:user.createdAt},token});
    });
    app.post("/login",async (request,reply)=>{
        const {email,password}=request.body as {email?:string,password?:string};
        if(!email||!password){
            return reply.code(400).send({error:"Email and password is mandatory"});
        }
        const existingUser=await prisma.user.findUnique({where:{email}});
        if(!existingUser||!(await bcrypt.compare(password,existingUser.passwordHash))){
            return reply.code(401).send({error:"Invalid Credentials"});
        }
        const token=app.jwt.sign({userId:existingUser.id,email:existingUser.email,},{expiresIn:"24h"});
        return reply.code(200).send({user:{userId:existingUser.id,email:existingUser.email,createdAt:existingUser.createdAt},token});
    });
    app.get('/me',{preHandler:[app.authenticate]},async (request,reply)=>{
        const user=await prisma.user.findUnique({
            where:{id:request.user.userId},
            select:{id:true,email:true,createdAt:true}
        });
        return reply.code(200).send(user);
    });
}
export default authRoute;