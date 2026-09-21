import cron from 'node-cron';
import { prisma } from './prisma'; 
import { s3Client } from './s3';
import { ListObjectsV2Command,DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { mediaQueue } from './queue';

async function deleteS3Prefix(bucket: string, prefix: string) {
  try {
    let isTruncated = true;
    let continuationToken: string | undefined;

    while (isTruncated) {
      const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      });

      const listResult = await s3Client.send(listCommand);

      if (listResult.Contents && listResult.Contents.length > 0) {
        const deleteCommand = new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: listResult.Contents.map((obj) => ({ Key: obj.Key })),
          },
        });
        await s3Client.send(deleteCommand);
      }

      isTruncated = listResult.IsTruncated ?? false;
      continuationToken = listResult.NextContinuationToken;
    }
  } catch (error) {
    console.error(`[S3 Delete Error] Failed prefix cleanup "${prefix}" in bucket "${bucket}":`, error);
    throw error //making sure any error in deletion will throw an over all error causing an transaction block
  }
}

export async function cleanupStaleUploads() {
  console.log('Running stale upload cleanup job...');

  const oneHourAgo = new Date(
    Date.now() -  30 * 60 * 1000
  );

  try{
    const result = await prisma.file.findMany({
      where: {
        status:{ in: ['PENDING','PROCESSING']},
        updatedAt: {
          lt: oneHourAgo,
        },
      }
    });

    if (result.length === 0){ 
      console.log('[Cleanup Job] No stale records found.');
      return;}
    console.log(`[Cleanup] Found ${result.length} stale processing file(s). Starting cleanup...`);
    for(const file of result){
      try{
        if (file.storageKey) {
          await deleteS3Prefix('raw-media-bucket', file.storageKey);
        }
        if (file.status === 'PROCESSING') {
          await deleteS3Prefix('processed-media-bucket', `processed/${file.userId}/${file.id}/`);
        }
        
        await prisma.file.update({
          where: { id: file.id },
          data: {
            status: 'FAILED',
          },
        });
        const jobId = `media-job-${file.id}`;
        const job = await mediaQueue.getJob(jobId);
        if (job) {
          await job.remove();
        }
        console.log(`[Cleanup] Successfully cleaned up stale file ${file.id}`);
      } catch(fileError){
          console.error(`[Cleanup Error] Failed to process file ID ${file.id}:`, fileError);  
      }
    }
  }catch(globalError){
    console.error('[Cleanup Job Fatal] Batch query execution failed:', globalError)
  }  
}
export function initCleanupJobs() {
  // Run every hour at minute 0
  cron.schedule('*/15 * * * *',cleanupStaleUploads);
}