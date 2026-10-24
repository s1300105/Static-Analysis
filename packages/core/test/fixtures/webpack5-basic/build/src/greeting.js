// マルチバイト文字（3 バイト）とサロゲートペア（4 バイト）を含む
export const GREETING = 'こんにちは ✓ 😀';

export function greet(name) {
  return `${GREETING}, ${name}!`;
}
