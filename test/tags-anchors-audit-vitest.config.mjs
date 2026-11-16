import os from 'node:os'
import path from 'node:path'

// 只隔离 Vite 缓存，保持默认并发、超时和用例发现规则。
export default { cacheDir: path.join(os.tmpdir(), 'tags-anchors-audit-vite-cache') }
