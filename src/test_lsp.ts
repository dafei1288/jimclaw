function add(a: number, b: number): number {
  return a + b;
}

// 故意制造类型错误：传入字符串
const result = add(1, "2");
console.log(result);
