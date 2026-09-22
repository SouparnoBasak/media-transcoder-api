import dotenv from 'dotenv';
import { buildApp } from './app';

dotenv.config();

const start = async () => {
  try {
    const app = await buildApp();
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ port, host: '0.0.0.0' });
    console.log(`Server running on http://localhost:${port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();