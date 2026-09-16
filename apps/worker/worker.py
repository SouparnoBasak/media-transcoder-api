import asyncio
import io
import json
import os
from datetime import datetime 
from bullmq import Worker
import psycopg2
import boto3
from PIL import Image


REDIS_URL=os.getenv(
    'REDIS_URL',"redis://localhost:6379"
)
DB_URL=os.getenv(
    'DATABASE_URL',"postgresql://saas_user:saas_password@localhost:5432/saas_db"
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

async def update_db_status(fileId,actionType,error_msg=None):
    conn=psycopg2.connect(DB_URL)
    cursor=conn.cursor()

    try:
        status= "FAILED" if error_msg else "COMPLETED"
        cursor.execute(
            """
                UPDATE files
                SET status=%s::"FileStatus"
                WHERE id=%s
            """,
            (status,fileId)
        )

        completedAt=None if error_msg else datetime.utcnow()
        cursor.execute(
            """
            INSERT INTO jobs (id,file_Id,action_type,error_message,completed_at)
            VALUES (gen_random_uuid(),%s,%s,%s,%s)
            """,
            (fileId,actionType,error_msg,completedAt)
        )
        conn.commit()
        print(f"Database updated for file {fileId}")
    except Exception as db_error:
        conn.rollback()
        print("Database persistance failed")
        raise db_error
    finally:
        cursor.close()
        conn.close()


async def process_job(job,token):
    print("inside JOb")
    data=job.data
    print(data)
    fileId=data.get('fileId')
    userId=data.get('userId')
    storageKey=data.get('storageKey')
    actionType="image_resize_webp"

    print(f" [job: {job.id}] Picked up processing for file id {fileId} ")
    try:
        s3_response=s3.get_object(Bucket=RAW_BUCKET, Key=storageKey)
        raw_bytes=s3_response["Body"].read()

        img=Image.open(io.BytesIO(raw_bytes))

        display_buffer=io.BytesIO()
        img.save(display_buffer,format="WEBP",quality=80)
        display_buffer.seek(0)

        thumb_img = img.copy()
        thumb_img.thumbnail((200, 200))
        thumb_buffer = io.BytesIO()
        thumb_img.save(thumb_buffer, format="WEBP", quality=80)
        thumb_buffer.seek(0)

        display_key=f"processed/{userId}/{fileId}/display.webp"
        thumbnail_key=f"processed/{userId}/{fileId}/thumbnail.webp"

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
        print(f"Image processed and put in the {PROCESSED_BUCKET}")

        await update_db_status(fileId=fileId,actionType=actionType)
        return {"status":"complete","display_key":display_key, "thumbnail_key":thumbnail_key }
    except Exception as e:
        e_msg=str(e)
        print(f"[job: {job.id}: failed] {fileId}: {e_msg}")
        await update_db_status(
            fileId=fileId,
            actionType=actionType,
            error_msg=e_msg
        )

        raise e


async def main():
    print("Python worker listening:")
    worker=Worker(
        "media-processing",
        process_job,
        {"connection":REDIS_URL}
    )

    try:
        while True:
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        print("Worker shutting down")
        await worker.close()


if __name__=="__main__":
    asyncio.run(main())
