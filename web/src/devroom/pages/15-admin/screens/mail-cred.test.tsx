import { describe, expect, it } from 'vitest';
import { EMPTY_CRED, credMissing, credPatch } from './mail-cred';

// 这条链上最容易「看着正常但什么都没发生」的两处，都在这里钉住：
//   ① credPatch 拼出来的 secret 形状必须是 platform/mail/provider.go 的 creds
//      （resend 少 api_key、smtp 少 host 都会在**投递时**才炸，那时候错误离配置已经很远）；
//   ② 空值不许进请求体 —— PATCH 的语义是「出现的字段才写」。
describe('发信凭据的拼装（mail-cred）', () => {
  it('resend：只带 api_key', () => {
    expect(credPatch('resend', { ...EMPTY_CRED, apiKey: '  re_abc  ' })).toEqual({ secret: { api_key: 're_abc' } });
  });

  it('smtp：username/password 进 secret，host 进 options_json；port 空则不带', () => {
    expect(credPatch('smtp', { ...EMPTY_CRED, host: ' smtp.example.com ', username: 'u', password: 'p' }))
      .toEqual({ secret: { username: 'u', password: 'p' }, options_json: { host: 'smtp.example.com' } });
    expect(credPatch('smtp', { ...EMPTY_CRED, host: 'smtp.example.com', port: '465', username: 'u', password: 'p' }))
      .toEqual({ secret: { username: 'u', password: 'p' }, options_json: { host: 'smtp.example.com', port: 465 } });
  });

  it('log：一个字段都不发（它不需要凭据）', () => {
    expect(credPatch('log', { ...EMPTY_CRED, apiKey: 'x', host: 'y' })).toEqual({});
  });

  it('缺项判定按 provider 分别成立（三个 provider 各一条）', () => {
    expect(credMissing('resend', EMPTY_CRED)).not.toBe('');
    expect(credMissing('resend', { ...EMPTY_CRED, apiKey: 'k' })).toBe('');
    expect(credMissing('smtp', { ...EMPTY_CRED, username: 'u', password: 'p' })).toContain('host');
    expect(credMissing('smtp', { ...EMPTY_CRED, host: 'h' })).toContain('username');
    expect(credMissing('smtp', { ...EMPTY_CRED, host: 'h', username: 'u', password: 'p' })).toBe('');
    expect(credMissing('log', EMPTY_CRED)).toBe('');
  });

  it('只有空白也算没填（trim 之后再判）', () => {
    expect(credMissing('resend', { ...EMPTY_CRED, apiKey: '   ' })).not.toBe('');
    expect(credMissing('smtp', { ...EMPTY_CRED, host: '  ', username: 'u', password: 'p' })).toContain('host');
  });
});
