// 部分改编自 obsidian-llm-wiki（Apache-2.0），已修改。来源及版权见 THIRD_PARTY_NOTICES.md。
export const evidenceContextRule = '每个原子主张保留对象、方法、数值和条件。完整上下文取证限合法原段，不限定句数，不以名称片段代替证据。覆盖研究结果（数值、效应方向、显著性）、方法细节（设计、样本、工具、分析方法）与局限。'
export const identityRule = '主题成员必须同对象同问题，术语必须同指称；区分研究设计与研究结果。逐项核对对象身份、角色和所回答的问题；研究者使用的访谈方法不能当作受访者岗位职责，学生经历不能直接归入专业岗位经验。相关、上下位或组成关系不等于同义；同名缩写也可能指不同对象。拿不准的成员放 removed_members 留在来源层，术语保持独立。'
export const attributionRule = '区分作者主张与转述他人观点：作者断言、接受的证据可作为其结论；仅引用批评者、旧综述、少数观点、待检验假说或反驳对象，不等于作者赞同。不得把转述写成作者结论。'
export const vocabularyRule = '规范词表 vocabulary 与写入验证共用；优先复用其中同指称的标签与术语，别名必须是本篇原文实际使用的名称，不编造、不自行翻译；歧义名称不强行归并。'
export const topicStudyRule = '研究逐句署来源简称/已有作者年份，禁跨句“该研究/上述研究/this study”。P1等编号改可读描述或首次释义及归属；禁猜编。'
export const topicEvidenceContextRule = 'quote 仍逐字校验；context 为完整原句及必要前句，与 quote 相同时省略。只辨明指代、归属、条件和否定，不替换或扩充 quote，不据其新增独立事实。'
export const topicContinuationRule = 'previous_sentence 是删改后实际前句，null 为无前句，只解析承接、不作证据。不得沿用被删句或套用新前句身份；指代不明判支撑不足。'
