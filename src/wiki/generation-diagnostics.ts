import { ZodError } from 'zod'
import { ModelCallError, ModelOutputValidationError } from '../llm/client.js'
import { QuoteLocationError } from '../ingest/extraction.js'
import { signature } from '../storage/files.js'

export type DiagnosticKind='quote'|'budget'|'schema'|'timeout'|'io'|'model'|'coverage'
export interface GenerationDiagnostic {
  id:string;kind:DiagnosticKind;scope:'claim'|'chunk'|'source'|'comparison'|'job';phase:string;message:string
  sourceId?:string;sourcePath?:string;chunkId?:string;claimId?:string;start?:number;end?:number;line?:number
  text?:string;quote?:string;candidateIds?:string[];claimIds?:string[];io?:unknown
}
export function diagnosticKind(error:unknown):DiagnosticKind {
  if(error instanceof QuoteLocationError)return 'quote'
  if(error instanceof Error&&'ioDiagnostic'in error)return 'io'
  if(error instanceof Error&&'code'in error&&/^(?:E[A-Z]+|SQLITE_)/.test(String(error.code)))return 'io'
  if(error instanceof ModelCallError)return ['context-limit','max-tokens'].includes(error.code)?'budget':['empty-output','missing-finish'].includes(error.code)?'schema':'model'
  if(error instanceof Error&&error.name==='TimeoutError')return 'timeout'
  if(error instanceof ModelOutputValidationError)return diagnosticKind(error.cause)==='model'?'schema':diagnosticKind(error.cause)
  if(error instanceof ZodError||error instanceof SyntaxError)return 'schema'
  if(error instanceof Error&&error.cause&&error.cause!==error)return diagnosticKind(error.cause)
  return 'model'
}
export function recoverableGenerationError(error:unknown):boolean {
  return ['quote','budget','schema','timeout'].includes(diagnosticKind(error))
}
export function generationDiagnostic(error:unknown,context:Omit<GenerationDiagnostic,'id'|'kind'|'message'>):GenerationDiagnostic {
  const message=error instanceof Error?error.message:String(error),kind=diagnosticKind(error)
  return {id:signature(JSON.stringify([kind,context,message])),kind,message,...context,
    ...(error instanceof Error&&'ioDiagnostic'in error?{io:error.ioDiagnostic}:{})}
}
export function addDiagnostic(items:GenerationDiagnostic[],item:GenerationDiagnostic):void {
  if(!items.some(previous=>previous.id===item.id))items.push(item)
}
export function diagnosticSummary(items:GenerationDiagnostic[]):Partial<Record<DiagnosticKind,number>> {
  const counts:Partial<Record<DiagnosticKind,number>>={}
  for(const item of items)counts[item.kind]=(counts[item.kind]??0)+1
  return counts
}
export function qualityLabels(language:string):{incomplete:string;report:string;resolved:string} {
  const key=language.toLowerCase().split('-')[0]!,labels:Record<string,string[]>={
    zh:['覆盖或比较尚未完成，请结合缺口清单使用本页。','生成缺口与待复核项','本次已处理此前记录的生成缺口。'],
    en:['Coverage or comparison is incomplete; consult the issue report.','Generation gaps and review items','Previously recorded generation gaps have been processed.'],
    ja:['抽出または比較が未完了です。問題一覧を確認してください。','生成の欠落と確認項目','以前の生成の欠落を処理しました。'],
    ko:['추출 또는 비교가 완료되지 않았습니다. 문제 목록을 확인하세요.','생성 누락 및 검토 항목','이전 생성 누락을 처리했습니다.'],
    es:['La cobertura o comparación está incompleta; consulte el informe.','Lagunas de generación y revisión','Se han procesado las lagunas anteriores.'],
    fr:['La couverture ou la comparaison est incomplète ; consultez le rapport.','Lacunes de génération et vérifications','Les lacunes précédentes ont été traitées.'],
    de:['Abdeckung oder Vergleich ist unvollständig; siehe Bericht.','Generierungslücken und Prüfpunkte','Frühere Generierungslücken wurden bearbeitet.'],
    pt:['A cobertura ou comparação está incompleta; consulte o relatório.','Lacunas de geração e revisão','As lacunas anteriores foram processadas.'],
    ru:['Извлечение или сравнение не завершено; см. отчёт.','Пробелы генерации и проверка','Предыдущие пробелы обработаны.'],
    it:['Copertura o confronto incompleto; consultare il rapporto.','Lacune di generazione e verifiche','Le lacune precedenti sono state elaborate.'],
  },values=labels[key]??labels.en!
  return {incomplete:values[0]!,report:values[1]!,resolved:values[2]!}
}
