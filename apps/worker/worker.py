import asyncio
import io
import json
import os
from datetime import datetime
import boto3
from bullmq import Worker
import psycopg2
from PIL import Image

# ------------------------------------------------------------------------------
# Configuration & Client Initialization
# ------------------------------------------------------------------------------
DB_URI = os.getenv(
    "DATABASE_URL",
    "postgresql://saas_user:saas_password@localhost:5432/saas_db"
)
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

S3_ENDPOINT = os.getenv("S3_ENDPOINT", "http://localhost:9000")
MINIO_USER = os.getenv("MINIO_ROOT_USER", "minioadmin")
MINIO_PASS = os.getenv("MINIO_ROOT_PASSWORD", "minioadmin")

RAW_BUCKET = os.getenv("RAW_MEDIA_BUCKET", "raw-media-bucket")
PROCESSED_BUCKET = os.getenv("PROCESSED_MEDIA_BUCKET", "processed-media-bucket")

s3 = boto3.client(
    "s3",
    endpoint_url=S3_ENDPOINT,
    aws_access_key_id=MINIO_USER,
    aws_secret_access_key=MINIO_PASS,
    region_name="us-east-1"
)

# ------------------------------------------------------------------------------
# Database Persistence Helper
# ------------------------------------------------------------------------------
def update_db_status(file_id: str, action_type: str, error_msg: str = None):
    """
    Updates the File record status and writes an execution log to the Job table.
    Matches schema.prisma mappings: 'files' and 'jobs'.
    """
    conn = psycopg2.connect(DB_URI)
    cursor = conn.cursor()
    
    try:
        status = "FAILED" if error_msg else "COMPLETED"
        
        # 1. Update status on 'files' table
        cursor.execute(
            """
            UPDATE files 
            SET status = %s::"FileStatus"
            WHERE id = %s
            """,
            (status, file_id)
        )
        
        # 2. Insert audit entry into 'jobs' table
        completed_at = None if error_msg else datetime.utcnow()
        cursor.execute(
            """
            INSERT INTO jobs (id, file_id, action_type, error_message, completed_at)
            VALUES (gen_random_uuid(), %s, %s, %s, %s)
            """,
            (file_id, action_type, error_msg, completed_at)
        )
        
        conn.commit()
        print(f"💾 [PostgreSQL] State updated for File ID {file_id} -> {status}")
    except Exception as db_err:
        conn.rollback()
        print(f"❌ [PostgreSQL Error] Failed to persist state for {file_id}: {str(db_err)}")
        raise db_err
    finally:
        cursor.close()
        conn.close()

# ------------------------------------------------------------------------------
# Core Task Execution Pipeline
# ------------------------------------------------------------------------------
async def process_job(job, token):
    data = job.data
    file_id = data.get("fileId")
    user_id = data.get("userId")
    storage_key = data.get("storageKey")
    action_type = "IMAGE_RESIZE_WEBP"

    print(f"⚡ [Job {job.id}] Picked up task for File ID: {file_id}")

    try:
        # Step 1: Read raw binary stream from MinIO (raw-media-bucket)
        print(f"📥 [S3 Fetch] Pulling key: {storage_key}")
        s3_response = s3.get_object(Bucket=RAW_BUCKET, Key=storage_key)
        raw_bytes = s3_response["Body"].read()

        # Step 2: In-memory image processing using Pillow
        print("⚙️ [Processing] Generating optimized WebP display and thumbnail variants...")
        img = Image.open(io.BytesIO(raw_bytes))

        # 2a. Display Variant (WebP, 80% quality)
        display_buffer = io.BytesIO()
        img.save(display_buffer, format="WEBP", quality=80)
        display_buffer.seek(0)

        # 2b. Thumbnail Variant (200x200 max square)
        thumb_img = img.copy()
        thumb_img.thumbnail((200, 200))
        thumb_buffer = io.BytesIO()
        thumb_img.save(thumb_buffer, format="WEBP", quality=80)
        thumb_buffer.seek(0)

        # Step 3: Direct S3 write to destination bucket (processed-media-bucket)
        display_key = f"processed/{user_id}/{file_id}/display.webp"
        thumb_key = f"processed/{user_id}/{file_id}/thumb.webp"

        s3.put_object(
            Bucket=PROCESSED_BUCKET,
            Key=display_key,
            Body=display_buffer,
            ContentType="image/webp"
        )
        s3.put_object(
            Bucket=PROCESSED_BUCKET,
            Key=thumb_key,
            Body=thumb_buffer,
            ContentType="image/webp"
        )
        print(f"📤 [S3 Upload] Successfully stored variants to {PROCESSED_BUCKET}")

        # Step 4: Record success state in PostgreSQL
        update_db_status(file_id=file_id, action_type=action_type)

        return {"status": "COMPLETED", "displayKey": display_key, "thumbKey": thumb_key}

    except Exception as e:
        error_message = str(e)
        print(f"❌ [Job Failed] File ID {file_id}: {error_message}")

        # Record failure state in PostgreSQL
        update_db_status(
            file_id=file_id,
            action_type=action_type,
            error_msg=error_message
        )

        # Re-raise so BullMQ tracks the failure/retry attempt in Redis
        raise e

# ------------------------------------------------------------------------------
# Worker Initialization Loop
# ------------------------------------------------------------------------------
async def main():
    print("🚀 [Worker System] Background media processor running...")
    
    # Listens on 'media-processing' queue defined in Fastify queue producer
    worker = Worker(
        "media-processing",
        process_job,
        {"connection": REDIS_URL}
    )

    try:
        # Keep process alive
        while True:
            await asyncio.sleep(1)
    except asyncio.CancelledError:
        print("🛑 Shutting down worker...")
        await worker.close()

if __name__ == "__main__":
    asyncio.run(main())