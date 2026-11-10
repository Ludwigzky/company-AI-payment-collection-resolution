// 固定的官方来源目录。summary 为人工整理的摘要，不能作为法条原文展示。
// verifiedAt 记录本次资料核查日期，不代表系统进行持续联网核验。
export const SOURCES = [
  {
    id: 'civil-code',
    title: '中华人民共和国民法典',
    issuer: '全国人民代表大会；最高人民法院网站公布全文',
    url: 'https://www.court.gov.cn/zixun/xiangqing/233181.html',
    kind: 'law',
    articles: ['第五百零九条', '第五百七十七条', '第五百七十九条', '第五百八十二条', '第六百二十六条', '第六百二十八条'],
    summary: '合同履行、违约补救、金钱债务支付及买卖价款的规定。设备存在质量或履约争议时，应结合合同、问题原因和证据评估维修等补救措施与付款请求；不能仅凭欠款金额认定对方必须支付全部争议款。',
    verifiedAt: '2026-11-10',
    locator: '官方全文页面；可在浏览器中搜索对应中文条号，未提供条文直达锚点。',
    versionNote: '2020 年 5 月 28 日通过，2021 年 1 月 1 日施行；历史案件及相关司法解释需另行审查。'
  },
  {
    id: 'arbitration-law',
    title: '中华人民共和国仲裁法',
    issuer: '全国人大常委会；司法部智慧普法平台公布全文',
    url: 'https://legalinfo.moj.gov.cn/pub/sfbzhfx/zt/2025nzt0120/xcgvxxddzcf/202509/t20250915_525094.html',
    kind: 'law',
    articles: ['第三条', '第四条', '第五条', '第二十七条至第三十一条', '第九十六条'],
    summary: '合同财产纠纷可依法仲裁。申请前须核查仲裁协议、约定机构和效力；有效仲裁协议通常影响法院受理同一纠纷。协议未知或有争议时，应先由法务核查，不能直接确定诉讼或仲裁路径。',
    verifiedAt: '2026-11-10',
    locator: '官方全文页面；搜索“第四条”“第五条”及仲裁协议章节。',
    versionNote: '2025 年 9 月 12 日修订，2026 年 3 月 1 日施行。'
  },
  {
    id: 'sme-payment',
    title: '保障中小企业款项支付条例',
    issuer: '国务院；司法部国家行政法规库',
    url: 'https://xzfg.moj.gov.cn/front/law/detail?LawID=1764',
    kind: 'law',
    articles: ['第二条', '第三条', '第二十四条', '第二十五条', '第三十七条'],
    summary: '适用于机关、事业单位和大型企业采购货物、工程、服务向中小企业付款的情形；企业规模以订立合同时确定。符合条件的拖欠款可按规定投诉，投诉人与被投诉人须存在合同关系；普通中小企业之间欠款不能当然使用这一渠道。',
    verifiedAt: '2026-11-10',
    locator: '国家行政法规库全文及历史沿革；搜索对应条号。',
    versionNote: '国务院令第 802 号，2025 年 3 月 17 日修订，2025 年 6 月 1 日施行；历史事实的时间适用须另核。'
  },
  {
    id: 'sme-complaint',
    title: '全国违约拖欠中小企业款项投诉平台',
    issuer: '工业和信息化部',
    url: 'https://sme-dj.miit.gov.cn/',
    authorityUrl: 'https://ythzxfw.miit.gov.cn/bssx/ssts/art/2025/art_d2bf0d80a983451cb37e98e47210c712.html',
    rulesUrl: 'https://wap.miit.gov.cn/jgsj/qyj/bszn/art/2021/art_7f13eaf4919e4563a390cc9843a38ff7.html',
    kind: 'channel',
    articles: ['《保障中小企业款项支付投诉处理暂行办法》第六条、第七条'],
    summary: '中小企业可就机关、事业单位或大型企业采购货物、工程、服务的拒付或迟付问题核实投诉条件。须确认合同与企业规模，并核查同一事项是否已被法院、仲裁机构、其他行政部门或行业协会等调解组织受理或处理；不能默认与这些程序并行投诉。',
    verifiedAt: '2026-11-10',
    locator: '办事指南确认官方入口；平台为动态页面，具体材料和受理要求以登录后说明及主管部门要求为准。',
    versionNote: '核查了工信部办事指南及其引用的工信部企业〔2021〕224 号暂行办法；未提交投诉或测试登录后流程。'
  },
  {
    id: 'court-service',
    title: '人民法院在线服务网',
    issuer: '最高人民法院',
    url: 'https://zxfw.court.gov.cn/',
    authorityUrl: 'https://www.court.gov.cn/zixun/xiangqing/482581.html',
    kind: 'channel',
    articles: [],
    summary: '全国统一的电子诉讼服务入口，提供立案、调解、执行、保全等服务。进入前应核查仲裁条款、管辖、主体、诉讼请求与证据；网站入口本身不代表案件一定符合受理条件。',
    verifiedAt: '2026-11-10',
    locator: '最高人民法院 2025 年 11 月 27 日平台升级公告确认网址；具体业务须实名登录。',
    versionNote: '2025 年 12 月 1 日启用整合平台；本次仅核对官方入口，未提交立案或保全申请。'
  },
  {
    id: 'market-complaint',
    title: '市场监督管理投诉举报处理办法',
    issuer: '国家市场监督管理总局',
    url: 'https://www.samr.gov.cn/zw/zfxxgk/fdzdgknr/fgs/art/2026/art_e4d03a20c0fd49769e408c7bf3791ff5.html',
    kind: 'law',
    articles: ['第三条', '第八条', '第十六条', '第四十六条'],
    summary: '12315 的消费者投诉以生活消费争议为前提，企业经营性货款纠纷不能直接套用。涉嫌违反市场监管法律的真实线索可依法举报，但举报不等于裁决债务或代替回款诉讼，也不得虚构违法事实施压。',
    verifiedAt: '2026-11-10',
    locator: '总局公布全文；搜索第三条、第十六条。',
    versionNote: '市场监管总局令第 121 号，自 2026 年 4 月 15 日起施行，原暂行办法同时废止。'
  },
  {
    id: 'hotline-12345',
    title: '国务院办公厅关于进一步规范和提升12345热线服务的意见',
    issuer: '国务院办公厅；常州市天宁区政府网站转载全文',
    url: 'https://www.cztn.gov.cn/html/cztn/2025/NCBFQKNN_0625/209655.html',
    kind: 'channel',
    articles: ['第二部分第二项'],
    summary: '12345 可就政府管理或服务职责范围内的非紧急事项咨询、反映；需要诉讼、仲裁等法定程序解决的事项应引导至相应渠道。可先咨询属地涉企诉求受理范围，不能把 12345 当作普通商业欠款的强制催收渠道。',
    verifiedAt: '2026-11-10',
    locator: '政府网站转载全文；搜索“明确诉求分类处理方式”。',
    versionNote: '国办函〔2025〕66 号，2025 年 6 月 23 日成文；地方具体受理规则须按项目所在地核查。'
  }
];
