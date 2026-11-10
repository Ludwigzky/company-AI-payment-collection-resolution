import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.js',
  out: './drizzle',
  strict: true,
  verbose: true,
});
