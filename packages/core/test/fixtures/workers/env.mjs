export default function () {
  return process.env.SA_TEST_SECRET ?? null;
}
