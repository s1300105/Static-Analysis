export default async function ({ ms }) {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, ms));
  return { start, end: Date.now() };
}
