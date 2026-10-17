import { useEffect, useState } from 'react'
import { Cassette } from './primitives'
import { meApi } from '@/lib/api'
import { formatDate } from '@/lib/format'
import type { PersonalToken } from '@/types'

const scopes = [
  ['playlist:read', '读取歌单'], ['playlist:write', '修改歌单（添加/删除歌曲）'],
  ['history:read', '读取播放历史与统计'], ['player:control', '控制播放（需 App 在线）'], ['together:request', '一起听房间'],
] as const
const lastUsed = (time: number | null) => {
  if (time === null) return '未使用'
  const minutes = Math.max(1, Math.floor((Date.now() - time) / 60000))
  return `最后使用 ${minutes < 60 ? `${minutes} 分钟` : minutes < 1440 ? `${Math.floor(minutes / 60)} 小时` : `${Math.floor(minutes / 1440)} 天`}前`
}

export function TokensSection({ notify, onLogout }: { notify: (message: string) => void, onLogout: () => void }) {
  const [tokens, setTokens] = useState<PersonalToken[]>([])
  const [mcpUrl, setMcpUrl] = useState(`${window.location.origin}/mcp`)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [selected, setSelected] = useState<string[]>(scopes.slice(0, 3).map(([scope]) => scope))
  const [expiry, setExpiry] = useState('never')
  const [plaintext, setPlaintext] = useState('')
  const [busy, setBusy] = useState(false)
  const report = (error: unknown) => notify(error instanceof Error ? error.message : '请求失败')
  const refresh = async() => setTokens((await meApi.tokens()).tokens)
  useEffect(() => {
    void refresh().catch(report)
    void meApi.serverInfo().then(info => { if (info.mcpUrl) setMcpUrl(info.mcpUrl) }).catch(report)
  }, [])
  const back = () => { setPlaintext(''); setCreating(false) }
  const generate = async(event: React.FormEvent) => {
    event.preventDefault()
    if (busy || plaintext) return
    setBusy(true)
    try {
      const result = await meApi.createToken({ name, scopes: selected, expiry })
      setPlaintext(result.token)
      await refresh()
    } catch (error) { report(error) } finally { setBusy(false) }
  }
  const revoke = async(token: PersonalToken) => {
    if (!window.confirm(`吊销令牌「${token.name}」？`)) return
    try { await meApi.revokeToken(token.id); await refresh() } catch (error) { report(error) }
  }
  const visible = tokens.filter(token => token.revokedAt === null)
  return <section className="lux-token-page">
    {creating ? <form onSubmit={generate}>
      <button type="button" className="lux-iconbtn lux-token-back" aria-label="返回" onClick={back}>‹</button>
      <div className="lux-eyebrow">MCP 令牌 · 新建</div><h1>新建令牌</h1>
      <input className="lux-input" aria-label="名称" value={name} onChange={event => setName(event.target.value)} maxLength={40} required disabled={!!plaintext} />
      <p className="lux-note">名称，方便以后认出</p>
      <h2>权限范围</h2>
      {scopes.map(([scope, label]) => <label className="lux-token-check" key={scope}>
        <input type="checkbox" checked={selected.includes(scope)} disabled={!!plaintext} onChange={event => setSelected(current => event.target.checked ? [...current, scope] : current.filter(s => s != scope))} />{label}
      </label>)}
      <div className="lux-token-line"><b>有效期</b><div className="lux-seg" role="group" aria-label="有效期">
        {[['30d', '30 天'], ['1y', '1 年'], ['never', '永不']].map(([value, label]) => <button type="button" key={value} className={expiry == value ? 'on' : undefined} disabled={!!plaintext} onClick={() => setExpiry(value!)}>{label}</button>)}
      </div></div>
      {plaintext ? <div className="lux-card lux-token-secret"><div className="lux-eyebrow">只显示这一次</div><Cassette value={plaintext} />
        <button type="button" className="lux-btn primary" onClick={() => void navigator.clipboard.writeText(plaintext).then(() => notify('已复制')).catch(report)}>复制</button>
      </div> : null}
      <footer className="lux-token-line"><button type="button" className="lux-btn ghost" onClick={back}>取消</button><button type="submit" className="lux-btn primary" disabled={busy || !!plaintext || !name.trim() || !selected.length}>生成令牌</button></footer>
    </form> : <>
      <div className="lux-token-line"><div className="lux-eyebrow">LUX SERVER · 管理后台</div><button type="button" className="lux-btn sm ghost" onClick={onLogout}>退出</button></div><h1>MCP 访问令牌</h1>
      <p className="lux-note">给 Grok Bot 等 AI 助手使用的长期令牌，只能做勾选的事</p>
      <h2 className="lux-token-line"><span>已创建</span><small className="lux-note">{visible.length} 个</small></h2>
      {visible.map(token => <article key={token.id} className="lux-token-item" style={{ opacity: token.expiresAt !== null && token.expiresAt <= Date.now() ? 0.5 : 1 }}>
        <div className="lux-token-line"><b>{token.name}</b><button type="button" className="lux-btn sm ghost" style={{ color: '#FA5252', borderColor: '#FA5252' }} onClick={() => void revoke(token)}>吊销</button></div>
        <p className="lux-note">{token.scopes.map(scope => scopes.find(([value]) => value == scope)?.[1]).join('、')}</p>
        <p className="lux-note">{token.expiresAt === null ? '永不过期' : `${formatDate(token.expiresAt).slice(0, 10)} 过期`} · {lastUsed(token.lastUsedAt)} · lux_mcp_••••{token.last4}</p>
      </article>)}
      <button type="button" className="lux-btn primary" style={{ marginTop: 14 }} onClick={() => { setName(''); setSelected(scopes.slice(0, 3).map(([scope]) => scope)); setExpiry('never'); setCreating(true) }}>＋ 新建令牌</button>
      <h2>连接信息</h2><div className="lux-card lux-token-connection mono">MCP 地址：{mcpUrl}<br />认证：Authorization: Bearer &lt;令牌&gt;</div>
    </>}
  </section>
}
