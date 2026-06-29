import * as crypto from 'crypto';

/** RSA 公钥信息（服务器下发） */
export interface RsaInfo {
  rsa_pub: string;    // RSA 公钥（base64 DER 格式）
  rsa_code: string;   // 加密盐值
  rsa_flag: string;   // 分块分隔符
}

/**
 * 泛微 Weaver RSA 加密工具
 *
 * 登录密码使用自定义 RSA 方案加密：
 *   1. 从 /rsa/weaver.rsa.GetRsaInfo 获取公钥信息
 *   2. 将明文按 240 字符分块
 *   3. 每块追加 rsa_code 后使用 RSA PKCS1 加密 → base64
 *   4. 用 rsa_flag 连接各块
 */
export class RSACrypto {
  /** 将 base64 公钥转为 PEM 格式 */
  normalizePublicKey(rawKey: string): string {
    let cleaned = rawKey
      .replace(/-----BEGIN[^-]+-----/g, '')
      .replace(/-----END[^-]+-----/g, '')
      .replace(/[\s\r\n]/g, '');

    const lines: string[] = [];
    for (let i = 0; i < cleaned.length; i += 64) {
      lines.push(cleaned.substring(i, i + 64));
    }

    return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
  }

  /** RSA PKCS1 公钥加密 */
  encryptBlock(publicKey: string, data: string): string {
    const pemKey = publicKey.includes('-----BEGIN')
      ? publicKey
      : this.normalizePublicKey(publicKey);

    const buffer = Buffer.from(data, 'utf-8');
    const encrypted = crypto.publicEncrypt(
      {
        key: pemKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      buffer,
    );
    return encrypted.toString('base64');
  }

  /**
   * Weaver 自定义 RSA 加密
   *
   * @param rsaInfo 服务器下发的公钥信息
   * @param input 待加密的明文
   * @returns base64 密文（分块加密 + rsa_flag 连接）
   */
  encryptWithRsa(rsaInfo: RsaInfo, input: string): string {
    const { rsa_pub, rsa_code, rsa_flag } = rsaInfo;
    const chunkSize = 240;
    const results: string[] = [];

    if (input.length > chunkSize) {
      const chunkCount = Math.ceil(input.length / chunkSize);
      for (let i = 0; i < chunkCount; i++) {
        const chunk = input.substring(i * chunkSize, (i + 1) * chunkSize);
        if (chunk) {
          results.push(this.encryptBlock(rsa_pub, chunk + rsa_code) + rsa_flag);
        }
      }
      return results.join('');
    } else {
      return this.encryptBlock(rsa_pub, input + rsa_code) + rsa_flag;
    }
  }
}
