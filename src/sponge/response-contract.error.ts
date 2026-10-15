/** HTTP 成功响应违反固定数据契约；不能当作网络中断返回部分岗位。 */
export class SpongeResponseContractError extends Error {
  constructor(message: string) {
    super(`海绵响应数据契约错误：${message}`);
    this.name = 'SpongeResponseContractError';
  }
}
