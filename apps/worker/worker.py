import asyncio
from multiprocessing import Process,Queue
import io
import json
import os
from datetime import datetime 
from bullmq import Worker
import psycopg2
import boto3
import time
from PIL import Image


JOB_TIMEOUT_SECONDS=60
REDIS_URL=os.getenv(
    'REDIS_URL','redis://localhost:6379'
)
DB_URL=os.getenv(
    'DATABASE_URL','postgresql://saas_user:saas_password@localhost:5432/saas_db'
)
S3_ENDPOINT=os.getenv(
    'MINIO_ENDPOINT','http://localhost:9000'
)
MINIO_USER=os.getenv(
    'MINIO_ACCESS_KEY','minioadmin'
)
MINIO_PASS=os.getenv(
    'MINIO_SECRET_KEY','minioadmin'
)

RAW_BUCKET='raw-media-bucket'
PROCESSED_BUCKET='processed-media-bucket'

s3=boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT,
    aws_access_key_id=MINIO_USER,
    aws_secret_access_key=MINIO_PASS,
    region_name="us-east-1"
)

async def update_db_status(fileId,actionType,error=None,fileStatus=None):
    conn=psycopg2.connect(DB_URL)
    cursor=conn.cursor()
    try:
        if fileStatus:
            cursor.execute(
                '''
                UPDATE FILES
                SET STATUS=%s::"FileStatus" 
                WHERE id =%s
                ''',
                (fileStatus,fileId)
            )
            print("file table updated")

        completedAt=None if error else datetime.utcnow()
        cursor.execute(
            '''
            INSERT INTO jobs(id,file_id,action_type,error_message,completed_at)
            VALUES (gen_random_uuid(),%s,%s,%s,%s)
            ''',
            (fileId,actionType,error,completedAt)
        )
        conn.commit()
        print(f"Database updated for {fileId}")
    except Exception as db_error:
        conn.rollback()
        print("Database persistance failure")
        raise db_error
    finally:
        cursor.close()
        conn.close()

def execute_media_pipeline_sync(data):
    print("INSIDE PIPELINE")
    fileId = data["fileId"]
    userId = data["userId"]
    storageKey = data["storageKey"]
    try:
        s3_response = s3.get_object(
        Bucket=RAW_BUCKET,
        Key=storageKey
    )
    except Exception as minio_error:
        raise RuntimeError(
            f"Error while fetching data; {minio_error}"
        )
    
    raw_bytes = s3_response["Body"].read()

    try:
        img = Image.open(io.BytesIO(raw_bytes))
        img.verify()
        img = Image.open(io.BytesIO(raw_bytes))
    except Exception as img_error:
        raise ValueError(
            f"Uploaded file is corrupted or not a valid image: {img_error}"
        )
    
    try:
        display_buffer = io.BytesIO()
        img.save(display_buffer,format="WEBP",quality=80)
        display_buffer.seek(0)

        thumb_img = img.copy()
        thumb_img.thumbnail((200, 200))
        thumb_buffer = io.BytesIO()
        thumb_img.save(
            thumb_buffer,
            format="WEBP",
            quality=80
        )
        thumb_buffer.seek(0)
    except Exception as e:
        raise RuntimeError(
            f"Error processing the file:{e}"
        )
    
    display_key = (f"processed/{userId}/{fileId}/display.webp")

    thumbnail_key = (f"processed/{userId}/{fileId}/thumbnail.webp")
    
    try:
        s3.put_object(
        Bucket=PROCESSED_BUCKET,
        Key=display_key,
        Body=display_buffer,
        ContentType="image/webp"
        )   

        s3.put_object(
            Bucket=PROCESSED_BUCKET,
            Key=thumbnail_key,
            Body=thumb_buffer,
            ContentType="image/webp"
        )
    except Exception as e:
        raise RuntimeError(
            f"Error uploading file:{e}"
        )

    return {
        "status": "complete",
        "display_key": display_key,
        "thumbnail_key": thumbnail_key
    }


def child_entry(job_data,result_queue):
    try:
        result=execute_media_pipeline_sync(job_data)

        result_queue.put({
            "success":True,
            "result":result
        })
    except Exception as e:
        result_queue.put({
            "success":False,
            "error":str(e)
        })   

def is_final_attempt(job):
    return job.attemptsMade >= job.opts.get("attempts", 1) - 1

async def process_job(job,token):
    print("JOB ID:", job.id)
    print("ATTEMPTS MADE:", getattr(job, "attemptsMade", "NOT FOUND"))
    job_data={
        "fileId":job.data.get("fileId"),
        "userId":job.data.get("userId"),
        "storageKey":job.data.get("storageKey")
    }
    result_queue=Queue()

    child=Process(
        target=child_entry,
        args=(job_data,result_queue)
    )

    child.start()

    try:
        await asyncio.to_thread(
            child.join,
            JOB_TIMEOUT_SECONDS
        )

        if(child.is_alive()):
            print(f"[Job {job.id} Timeout]: File id {job_data['fileId']} excedded 60 secs")
            child.terminate()
            child.join()
            await update_db_status(
                fileId=job_data["fileId"],
                actionType="IMAGE-RESIZE-WEBP",
                error="Process timed out after 60 seconds",
                fileStatus="FAILED" if is_final_attempt(job) else None
            )
            raise Exception('Process timed out after 60s')
        
        if result_queue.empty():
            raise Exception ("Child process exited without a result")
        
        result=result_queue.get()
        if not result["success"]:
            await update_db_status(
                fileId=job_data["fileId"],
                actionType="IMAGE-RESIZE-WEBP",
                error=result["error"],
                fileStatus="FAILED" if is_final_attempt(job) else None
            )
            raise Exception(result["error"])
        
        await update_db_status(
            fileId=job_data['fileId'],
            actionType="IMAGE-RESIZE-WEBP",
            fileStatus="COMPLETED"
        )
        return result["result"]

    finally:
        if child.is_alive():
            child.terminate()
        
        child.join()


async def main():
    print("Python worker listening:")
    worker=Worker(
        "media-processing",
        process_job,
        {
            "connection":REDIS_URL,
            "stalledInterval":30000,
            "maxStalledCount":2
        }
    )

    try:
        while True:
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        print("Worker shutting down")
        await worker.close()


if __name__=="__main__":
    asyncio.run(main())
