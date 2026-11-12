// 优先按 UTF-8 读取；兼容带 BOM 的 UTF-16 和旧中文资料的 GB18030，原始快照不改写。
export function decodeSourceText(bytes:Uint8Array):string {
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder('utf-16le',{fatal:true}).decode(bytes)
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder('utf-16be',{fatal:true}).decode(bytes)
  try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes)}
  catch{return new TextDecoder('gb18030',{fatal:true}).decode(bytes)}
}
