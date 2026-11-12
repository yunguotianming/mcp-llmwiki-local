import { layeredSettings, type LayeredSettings } from '../domain/config.js'
import { readCurrent, readManifest } from './objects.js'
import { detectOllama, embeddingHelp, libraryVectorState, queryInput } from './vector-identity.js'
import { cloudEmbeddingKey } from './cloud-embedding.js'

export async function vectorStatus(root: string, value: Partial<LayeredSettings>, signal?: AbortSignal) {
  const settings = layeredSettings(value), manifest = await readManifest(root, await readCurrent(root))
  const state = await libraryVectorState(root, manifest, value)
  const identity = state?.identity
  let available = '', retrieval = '仅全文', model = settings.localEmbeddingModel
  const cloudStatus = () => {
    model = identity?.provider === 'cloud' ? identity.model : settings.cloudEmbeddingModel
    available = cloudEmbeddingKey(settings) ? `已配置云端：${model}；建库或查询时验证服务` : '云端密钥环境变量未设置或格式无效。'
    if (identity?.provider === 'cloud' && cloudEmbeddingKey(settings)) retrieval = '全文＋语义（查询时核验服务与维度）'
    else if (!state && cloudEmbeddingKey(settings)) retrieval = '尚未建库，首次建库时锁定身份'
  }
  if (identity) settings.localEmbeddingModel = identity.model
  if (state?.mode === 'none' || !state && settings.embeddingMode === 'none') available = '已选择不使用向量，不检测服务。'
  // 设置页不向云端发送探针或资料，只报告本机配置；身份锁定后不回落到其他服务。
  else if (identity?.provider === 'cloud' || !identity && settings.embeddingMode === 'cloud') cloudStatus()
  else try {
    const found = await detectOllama(settings, false, signal)
    model = found.model
    available = `可用：${found.model}`
    if (identity && found.model === identity.model && found.revision === identity.revision) { queryInput('', identity); retrieval = '全文＋语义（查询时核验维度）' }
    else if (identity) available += '；权重身份与本库不符'
    else if (!state) retrieval = '尚未建库，首次建库时锁定身份'
  } catch (error) {
    signal?.throwIfAborted()
    available = error instanceof Error && /身份|前处理/.test(error.message) ? error.message : embeddingHelp
  }
  return { identity: identity ?? null, mode: state?.mode ?? 'new', generation: state?.generation ?? 0, coverage: state?.coverage ?? null,
    pendingPoints: state?.pending_points.length ?? 0, available, retrieval, model, message: state?.message ?? '' }
}
