import { useMemo, useRef, useState } from 'react'
import { adminApi } from '@/lib/api'
import { ChartCard, MetricTiles } from '@/components/charts'
import { DotPill, Field, Pill } from '@/components/primitives'
import { IconCircle, IconRefresh, IconScript, IconTrash } from '@/lib/icons'
import type { SourceScriptView, SourcesAdminResponse } from '@/types'

type UploadMode = 'paste' | 'file' | 'url'

type FileUploadOutcome = {
  fileName: string
  ok: boolean
  detail: string
}

const jsFilesFromList = (list: FileList | null | undefined): File[] => {
  if (!list?.length) return []
  return [...list].filter(f => f.name.toLowerCase().endsWith('.js'))
}

const statusLabel = (script: SourceScriptView) => {
  switch (script.status) {
    case 'ready': return { tone: 'ok' as const, text: '就绪' }
    case 'initializing': return { tone: 'warn' as const, text: '初始化中' }
    case 'error': return { tone: 'off' as const, text: '错误' }
    default: return { tone: 'off' as const, text: '已禁用' }
  }
}

const readFileAsText = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(typeof reader.result == 'string' ? reader.result : '')
  reader.onerror = () => reject(new Error('无法读取文件'))
  reader.readAsText(file, 'utf-8')
})

function UploadPanel({ refresh, notify }: { refresh: () => Promise<void>, notify: (m: string) => void }) {
  const [mode, setMode] = useState<UploadMode>('paste')
  const [enableAfter, setEnableAfter] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [fileOutcomes, setFileOutcomes] = useState<FileUploadOutcome[]>([])
  const [busy, setBusy] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pickedFiles, setPickedFiles] = useState<File[]>([])

  const applyPickedFiles = (files: File[]) => {
    const jsOnly = files.filter(f => f.name.toLowerCase().endsWith('.js'))
    if (files.length && !jsOnly.length) {
      setUploadError('仅支持 .js 文件')
      return
    }
    setUploadError(null)
    setFileOutcomes([])
    setPickedFiles(jsOnly)
  }

  const uploadScriptWithOptionalEnable = async(script: string, label: string): Promise<FileUploadOutcome> => {
    const uploaded = await adminApi.uploadSourceAttempt({ script })
    if (!uploaded.ok) return { fileName: label, ok: false, detail: uploaded.message }
    if (!enableAfter) {
      return { fileName: label, ok: true, detail: `成功 · ${uploaded.script.name}（已保存，默认禁用）` }
    }
    const enabled = await adminApi.enableSourceAttempt(uploaded.script.id)
    if (!enabled.ok) {
      return { fileName: label, ok: false, detail: `已保存 ${uploaded.script.name}，但启用失败：${enabled.message}` }
    }
    if (enabled.script.status == 'error' && enabled.script.error) {
      return { fileName: label, ok: false, detail: `已保存 ${uploaded.script.name}，但启用失败：${enabled.script.error}` }
    }
    const initHint = enabled.script.status == 'ready' ? '已启用' : '正在初始化…'
    return { fileName: label, ok: true, detail: `成功 · ${uploaded.script.name}（${initHint}）` }
  }

  const uploadFilesBatch = async(files: File[]) => {
    const outcomes: FileUploadOutcome[] = []
    for (const file of files) {
      try {
        const script = await readFileAsText(file)
        outcomes.push(await uploadScriptWithOptionalEnable(script, file.name))
      } catch (err) {
        outcomes.push({
          fileName: file.name,
          ok: false,
          detail: err instanceof Error ? err.message : '无法读取文件',
        })
      }
    }
    setFileOutcomes(outcomes)
    const okCount = outcomes.filter(o => o.ok).length
    const failCount = outcomes.length - okCount
    if (failCount == 0) notify(`已上传 ${okCount} 个脚本`)
    else if (okCount == 0) notify(`全部失败（${failCount} 个）`)
    else notify(`完成：${okCount} 成功，${failCount} 失败`)
    await refresh()
  }

  const submit = async(event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setUploadError(null)
    setFileOutcomes([])
    setBusy(true)
    const form = event.currentTarget
    try {
      if (mode == 'file') {
        const fromInput = jsFilesFromList(fileInputRef.current?.files)
        const files = pickedFiles.length ? pickedFiles : fromInput
        if (!files.length) throw new Error('请选择至少一个 .js 脚本文件')
        if (files.length > 1) {
          await uploadFilesBatch(files)
          setPickedFiles([])
          if (fileInputRef.current) fileInputRef.current.value = ''
          return
        }
        const script = await readFileAsText(files[0])
        const outcome = await uploadScriptWithOptionalEnable(script, files[0].name)
        setFileOutcomes([outcome])
        if (!outcome.ok) {
          setUploadError(outcome.detail)
          notify(outcome.detail)
        } else {
          notify(outcome.detail)
        }
        form.reset()
        setPickedFiles([])
        if (fileInputRef.current) fileInputRef.current.value = ''
        await refresh()
        return
      }

      let script: string | undefined
      let url: string | undefined
      if (mode == 'url') {
        url = (form.elements.namedItem('url') as HTMLInputElement).value.trim()
      } else {
        script = (form.elements.namedItem('script') as HTMLTextAreaElement).value
        if (!script.trim()) throw new Error('请粘贴脚本内容')
      }

      const uploaded = url
        ? await adminApi.uploadSourceAttempt({ url })
        : await adminApi.uploadSourceAttempt({ script: script! })
      if (!uploaded.ok) throw new Error(uploaded.message)

      form.reset()
      setPickedFiles([])
      if (fileInputRef.current) fileInputRef.current.value = ''

      if (enableAfter) {
        const enabled = await adminApi.enableSourceAttempt(uploaded.script.id)
        if (!enabled.ok) {
          setUploadError(`脚本已保存，但启用失败：${enabled.message}`)
          notify('脚本已上传，启用失败')
        } else if (enabled.script.status == 'error' && enabled.script.error) {
          setUploadError(`脚本已保存，但启用失败：${enabled.script.error}`)
          notify('脚本已上传，启用失败')
        } else {
          notify(enabled.script.status == 'ready' ? '脚本已上传并启用' : '脚本已上传，正在初始化…')
        }
      } else {
        notify('脚本已上传（默认禁用，可在列表中启用）')
      }
      await refresh()
    } catch (err) {
      const message = err instanceof Error ? err.message : '上传失败'
      setUploadError(message)
      notify(message)
    } finally {
      setBusy(false)
    }
  }

  const onDropFiles = (event: React.DragEvent) => {
    event.preventDefault()
    setDragOver(false)
    if (mode != 'file' || busy) return
    applyPickedFiles([...event.dataTransfer.files])
  }

  return (
    <div className="lux-card lux-create-panel">
      <form className="lux-create-bar inv" onSubmit={submit}>
        <div className="title">
          <IconCircle tone="admin"><IconScript /></IconCircle>
          <div>
            <h3>上传音源脚本</h3>
            <p>LX 自定义源格式（/** @name … */ 头注释必填），默认上传后禁用</p>
          </div>
        </div>
        <div className="lux-seg" role="group" aria-label="上传方式">
          <button type="button" className={mode == 'paste' ? 'on' : undefined} onClick={() => setMode('paste')}>粘贴脚本</button>
          <button type="button" className={mode == 'file' ? 'on' : undefined} onClick={() => setMode('file')}>选择文件</button>
          <button type="button" className={mode == 'url' ? 'on' : undefined} onClick={() => setMode('url')}>URL 下载</button>
        </div>
        {mode == 'url'
          ? <Field label="脚本 URL" name="url" placeholder="https://..." required />
          : mode == 'file'
            ? (
              <div className="lux-field">
                <label htmlFor="script-file">脚本文件 (.js，可多选)</label>
                <div
                  className={dragOver ? 'lux-drop on' : 'lux-drop'}
                  onDragOver={e => { e.preventDefault(); setDragOver(true) }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={onDropFiles}
                  style={{
                    border: '1px dashed var(--line)',
                    borderRadius: 12,
                    padding: 14,
                    background: dragOver ? 'var(--surface-2)' : 'transparent',
                  }}
                >
                  <input
                    id="script-file"
                    ref={fileInputRef}
                    name="scriptFile"
                    type="file"
                    accept=".js,text/javascript,application/javascript"
                    multiple
                    required={!pickedFiles.length}
                    onChange={e => applyPickedFiles(jsFilesFromList(e.target.files))}
                    style={{ width: '100%' }}
                  />
                  <p className="lux-note" style={{ marginTop: 8 }}>可一次选择多个文件，或拖拽 .js 到此处</p>
                  {pickedFiles.length ? (
                    <ul className="lux-note" style={{ marginTop: 8, paddingLeft: 18 }}>
                      {pickedFiles.map(f => (
                        <li key={`${f.name}-${f.size}`}>{f.name} · {(f.size / 1024).toFixed(1)} KB</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            )
            : (
              <div className="lux-field">
                <label htmlFor="script">脚本内容</label>
                <textarea
                  id="script"
                  name="script"
                  required
                  rows={8}
                  style={{ width: '100%', borderRadius: 12, padding: 12, border: '1px solid var(--line)', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                  placeholder={'/**\n * @name 我的源\n * @version 1\n */'}
                />
              </div>
            )}
        <label className="lux-note" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input type="checkbox" checked={enableAfter} onChange={e => setEnableAfter(e.target.checked)} />
          上传后立即启用（若沙箱初始化失败，错误会显示在下方与脚本列表中）
        </label>
        {uploadError ? (
          <p className="lux-note" role="alert" style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{uploadError}</p>
        ) : null}
        {fileOutcomes.length ? (
          <div className="lux-rows" style={{ gap: 6 }} role="status" aria-live="polite">
            {fileOutcomes.map(row => (
              <div key={row.fileName} className="lux-row" style={{ minHeight: 44, padding: '8px 12px' }}>
                <span className="mono" style={{ fontWeight: 600 }}>{row.fileName}</span>
                <span className="lux-note" style={{ color: row.ok ? 'var(--meta)' : 'var(--danger)' }}>
                  {row.ok ? '成功' : '失败'} · {row.detail}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <button type="submit" className="lux-btn primary" style={{ height: 40, padding: '0 18px' }} disabled={busy}>
          {busy ? '上传中…' : pickedFiles.length > 1 ? `上传 ${pickedFiles.length} 个文件` : '上传'}
        </button>
      </form>
    </div>
  )
}

function ScriptRow({
  script, refresh, notify,
}: { script: SourceScriptView, refresh: () => Promise<void>, notify: (m: string) => void }) {
  const st = statusLabel(script)
  const toggle = async() => {
    try {
      if (script.enabled) await adminApi.disableSource(script.id)
      else {
        const res = await adminApi.enableSource(script.id)
        if (res.script.status == 'error' && res.script.error) {
          notify(`启用失败：${res.script.error}`)
        } else {
          notify(script.enabled ? '已禁用' : '已启用')
        }
      }
      await refresh()
    } catch (err) {
      notify(err instanceof Error ? err.message : '操作失败')
    }
  }
  const remove = async() => {
    try {
      await adminApi.deleteSource(script.id)
      notify('脚本已删除')
      await refresh()
    } catch (err) {
      notify(err instanceof Error ? err.message : '删除失败')
    }
  }
  const sources = Object.keys(script.sources).join(', ') || '—'
  return (
    <div className="lux-row" style={{ minHeight: 64 }}>
      <IconCircle tone="admin"><IconScript /></IconCircle>
      <div className="t">
        <b>{script.name}</b>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 5 }}>
          <Pill tone="gray">#{script.priority}</Pill>
          <DotPill tone={st.tone}>{st.text}</DotPill>
          <span className="lux-note mono">{script.id}</span>
        </div>
        {script.error ? <p className="lux-note" style={{ color: 'var(--danger)', marginTop: 6 }}>{script.error}</p> : null}
        <p className="lux-note" style={{ marginTop: 4 }}>源：{sources}</p>
      </div>
      <div className="acts">
        <button type="button" className={script.enabled ? 'lux-btn sm ghost' : 'lux-btn sm primary'} onClick={() => void toggle()}>
          {script.enabled ? '禁用' : '启用'}
        </button>
        <button type="button" className="lux-iconbtn del" onClick={() => void remove()} title="删除"><IconTrash /></button>
      </div>
    </div>
  )
}

export function SourcesSection({
  data, refresh, notify,
}: {
  data: SourcesAdminResponse | null
  refresh: () => Promise<void>
  notify: (m: string) => void
}) {
  const scripts = data?.scripts ?? []
  const info = data?.info
  const settings = data?.settings
  const metrics = useMemo(() => ([
    { label: '可用', value: info?.available ? '是' : '否', tone: 'status' as const, hint: '解析' },
    { label: '脚本', value: scripts.length, tone: 'nav' as const, hint: '个' },
    { label: '就绪', value: scripts.filter(s => s.status == 'ready').length, tone: 'lime' as const, hint: 'worker' },
    { label: '代理', value: settings?.proxyStream ? '开' : '关', tone: 'invites' as const, hint: '流' },
  ]), [info, scripts, settings])

  return (
    <div className="lux-stack">
      <UploadPanel refresh={refresh} notify={notify} />
      <div className="lux-page-split invites">
        <div className="lux-card" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="lux-card-h">
            <div>
              <h3>音源脚本</h3>
              <p>启用后在 worker 沙箱中运行；优先级数字越小越先尝试</p>
            </div>
            <button type="button" className="lux-btn sm ghost" onClick={() => void refresh()}><IconRefresh />刷新</button>
          </div>
          <div className="lux-rows" style={{ flex: 1 }}>
            {!scripts.length ? <p className="lux-note" style={{ padding: '12px 16px' }}>暂无脚本</p> : scripts.map(script => (
              <ScriptRow key={script.id} script={script} refresh={refresh} notify={notify} />
            ))}
          </div>
        </div>
        <div style={{ display: 'grid', gap: 12, alignContent: 'start' }}>
          <ChartCard title="运行设置" hint="来自环境变量">
            <MetricTiles items={metrics} />
            {settings ? (
              <p className="lux-note" style={{ marginTop: 12 }}>
                超时 {settings.timeoutMs} ms · 内存 {settings.memoryMb} MB · 流代理 {settings.proxyStream ? '开启' : '关闭'}
              </p>
            ) : null}
          </ChartCard>
          {info ? (
            <ChartCard title="已声明能力" hint="所有就绪脚本取并集">
              <div className="lux-rows">
                {Object.entries(info.sources).map(([source, cap]) => (
                  <div key={source} className="lux-row" style={{ minHeight: 48 }}>
                    <Pill tone="mine">{source}</Pill>
                    <span className="lux-note">{cap?.actions.join(', ')} · {cap?.qualitys.join(', ')}</span>
                  </div>
                ))}
                {!Object.keys(info.sources).length ? <p className="lux-note">暂无在线源能力</p> : null}
              </div>
            </ChartCard>
          ) : null}
        </div>
      </div>
    </div>
  )
}
