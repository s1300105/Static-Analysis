export default function () {
  const keep = [];
  for (;;) keep.push(new Array(100_000).fill({ x: Math.random() }));
}
