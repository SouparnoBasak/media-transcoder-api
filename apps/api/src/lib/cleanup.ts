import cron from 'node-cron';
import { prisma } from './prisma'; // Adjust import path to your Prisma client


export async function cleanupStaleUploads() {
  console.log('Running stale upload cleanup job...');

  const twoHoursAgo = new Date(
    Date.now() - 2 * 60 * 60 * 1000
  );

  try {
    const result = await prisma.file.updateMany({
      where: {
        status: 'PENDING',
        createdAt: {
          lt: twoHoursAgo,
        },
      },
      data: {
        status: 'FAILED',
      },
    });

    if (result.count > 0) {
      console.log(
        `Marked ${result.count} stale PENDING uploads as FAILED.`
      );
    } else {
      console.log('No stale PENDING uploads found.');
    }
  } catch (error) {
    console.error('Error executing stale cleanup job:', error);
  }
}
export function initCleanupJobs() {
  // Run every hour at minute 0
  cron.schedule('0 * * * *',cleanupStaleUploads);
//   cron.schedule('0 * * * *', async () => {
//     console.log('Running stale upload cleanup job...');

//     const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

//     try{
//       // Mark PENDING records older than 2 hours as FAILED
//       const result = await prisma.file.updateMany({
//         where: {
//           status: 'PENDING',
//           createdAt: {
//             lt: twoHoursAgo,
//           },
//         },
//         data: {
//           status: 'FAILED',
//         },
//       });

//       if (result.count > 0) {
//         console.log(`Marked ${result.count} stale PENDING uploads as FAILED.`);
//       }
//     } catch (error) {   
//       console.error('Error executing stale cleanup job:', error);
//     }
//   });
}