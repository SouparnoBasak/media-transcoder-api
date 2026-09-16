import { prisma } from "./src/lib/prisma";

async function main() {
  // Get an existing user so the foreign-key relationship is valid
  const user = await prisma.user.findFirst();

  if (!user) {
    throw new Error("No user exists in the database.");
  }

  // 3 hours ago
  const threeHoursAgo = new Date(
    Date.now() - 3 * 60 * 60 * 1000
  );

  const testFile = await prisma.file.create({
    data: {
      userId: user.id,
      originalName: "cleanup-test.mp4",
      storageKey: "cleanup-test/dummy.mp4",
      status: "PENDING",
      mimeType: "video/mp4",
      sizeBytes: BigInt(1024),
      createdAt: threeHoursAgo,
    },
  });

  console.log("Created stale test file:");
  console.log({
    id: testFile.id,
    status: testFile.status,
    createdAt: testFile.createdAt,
    ageHours:
      (Date.now() - testFile.createdAt.getTime()) / (1000 * 60 * 60),
  });
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });