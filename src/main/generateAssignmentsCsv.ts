import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse';

/**
 * 读取CSV文件并解析为对象数组
 * @param filePath 输入CSV绝对路径
 */
async function readCsv(filePath: string): Promise<Record<string, string>[]> {
  const content = fs.readFileSync(filePath, 'utf8');
  return new Promise((resolve, reject) => {
    parse(content, { columns: true, trim: true }, (err, records: any[]) => {
      if (err) return reject(err);
      resolve(records as Record<string, string>[]);
    });
  });
}

/**
 * 将对象数组写为CSV（保留列顺序并对值进行必要转义）
 * @param rows 输出行
 * @param headers 列头顺序
 */
function writeCsv(rows: Record<string, any>[], headers: string[]): string {
  const escape = (v: any) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const headerLine = headers.join(',');
  const lines = rows.map(r => headers.map(h => escape(r[h])).join(','));
  return [headerLine, ...lines].join('\n');
}

/**
 * 规范化模板键，兼容 "tmpl-10" 与 "10"，返回数字字符串 "1".."10"
 */
function normalizeTemplateKey(input: string): string {
  if (!input) return '';
  const m = input.match(/(\d{1,2})$/);
  return m ? String(Number(m[1])) : input;
}

/**
 * 依据输入配额计算按班级的分配（确保每班至少1名，余数按班级规模比例分配）
 * @param quota 模板总名额
 * @param classSizes 各班学生数（按classIds顺序）
 */
function splitQuotaAcrossClasses(quota: number, classIds: number[], classSizes: number[]): Record<number, number> {
  const perClass: Record<number, number> = {};
  const classes = classIds;
  // 先保证每班至少1名
  const base = Math.min(quota, classes.length);
  for (const cid of classes) perClass[cid] = base > 0 ? 1 : 0;
  let remaining = quota - Object.values(perClass).reduce((a, b) => a + b, 0);
  if (remaining <= 0) return perClass;

  const totalSize = classSizes.reduce((a, b) => a + b, 0) || 1;
  // 按比例的向下取整分配
  const gains = classes.map((cid, idx) => ({
    cid,
    want: Math.floor((classSizes[idx] / totalSize) * remaining),
  }));
  let distributed = gains.reduce((a, g) => a + g.want, 0);
  for (const g of gains) perClass[g.cid] += g.want;
  // 把余下的一个个加到当前学生多的班级（或按cid稳定排序）
  const bySizeDesc = classes
    .map((cid, idx) => ({ cid, size: classSizes[idx] }))
    .sort((a, b) => b.size - a.size || a.cid - b.cid);
  while (distributed < remaining) {
    for (const it of bySizeDesc) {
      if (distributed >= remaining) break;
      perClass[it.cid] += 1;
      distributed += 1;
    }
  }
  return perClass;
}

/**
 * 主流程：读取白名单、按约束进行学生-模板-助教分配，输出新的CSV。
 * 用法：tsx src/main/generateAssignmentsCsv.ts <input_csv> <output_csv>
 */
async function main() {
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath) {
    throw new Error('Usage: tsx src/main/generateAssignmentsCsv.ts <input_csv> <output_csv>');
  }

  const absInput = path.resolve(inputPath);
  const rows = await readCsv(absInput);

  // 采集三类固定角色
  // 过滤出学生（允许同一邮箱同时存在 assistant_class 行；以 role === 'student' 为准）
  const students = rows.filter(r => r.role === 'student');

  // 统计各班学生数
  const classIds = Array.from(new Set(students.map(r => Number(r.classId)).filter(Boolean))).sort((a, b) => a - b);
  const classSizes = classIds.map(cid => students.filter(s => Number(s.classId) === cid).length);

  // 建立助教（技术）查找表：name→email
  const assistantTechByName = new Map<string, string>();
  for (const r of rows.filter(r => r.role === 'assistant_tech')) {
    assistantTechByName.set(r.name, r.email);
  }

  // 指定的模板→配额（数值串）与模板→助教
  // 说明：配额总计应为 114，与学生总数一致
  const templateQuota: Record<string, number> = {
    '10': 10,
    '5': 10,
    '8': 10,
    '2': 10,
    '7': 10,
    '6': 10,
    '4': 14,
    '1': 14,
    '3': 13,
    '9': 13,
  };

  const templateToAssistantName: Record<string, string> = {
    '10': '曹睿',
    '5': '曹睿',
    '8': '赵雅洁',
    '2': '赵雅洁',
    '7': '李俊松',
    '6': '李俊松',
    '4': '刘语晗',
    '1': '曹守苑',
    '3': '吕保侦',
    '9': '李玉涵',
  };

  const templateIds = Object.keys(templateQuota).sort((a, b) => Number(a) - Number(b));

  // 早期一致性校验：容量与配额
  const totalStudents = students.length;
  const totalCapacity = classSizes.reduce((a, b) => a + b, 0);
  const totalQuota = templateIds.reduce((a, t) => a + templateQuota[t], 0);
  console.log(`TOTAL students=${totalStudents} capacity=${totalCapacity} quota=${totalQuota}`);
  if (totalCapacity !== totalStudents) {
    const withoutClass = rows.filter(r => r.role === 'student' && !Number(r.classId)).map(r => r.email);
    throw new Error(`学生容量异常：有班级的=${totalCapacity}，学生总数=${totalStudents}。无班级学生=${withoutClass.length} (${withoutClass.join(',')})`);
  }
  if (totalQuota !== totalStudents) {
    throw new Error(`配额(${totalQuota})与学生数(${totalStudents})不一致，请调整模板配额或白名单。`);
  }

  // 全局容量约束：确保各模板按班级分配之和不超过本班学生数，且每模板每班至少1人
  const remainingCapacity: Record<number, number> = {};
  for (let i = 0; i < classIds.length; i++) remainingCapacity[classIds[i]] = classSizes[i];

  const perTemplatePerClass: Record<string, Record<number, number>> = {};
  for (const t of templateIds) {
    const quota = templateQuota[t];
    perTemplatePerClass[t] = {} as any;

    // 可参与分配的班级（仍有剩余容量）
    const usable = classIds.filter(cid => remainingCapacity[cid] > 0);
    if (usable.length === 0) {
      throw new Error(`没有可用班级容量供模板 ${t} 分配`);
    }

    // 基线：每个可用班级至少1人，但不超过总配额
    const base = Math.min(quota, usable.length);
    let allocated = 0;
    for (const cid of classIds) perTemplatePerClass[t][cid] = 0;
    for (let i = 0; i < base; i++) {
      const cid = usable[i % usable.length];
      if (remainingCapacity[cid] > 0) {
        perTemplatePerClass[t][cid] += 1;
        remainingCapacity[cid] -= 1;
        allocated += 1;
      }
    }

    // 分配余量：按剩余容量比例分配，不能超过班级剩余容量
    let remaining = quota - allocated;
    while (remaining > 0) {
      const candidates = classIds
        .map(cid => ({ cid, cap: remainingCapacity[cid] }))
        .filter(x => x.cap > 0)
        .sort((a, b) => b.cap - a.cap || a.cid - b.cid);
      if (candidates.length === 0) {
        throw new Error(`模板 ${t} 剩余 ${remaining} 无可用班级容量`);
      }
      for (const c of candidates) {
        if (remaining <= 0) break;
        perTemplatePerClass[t][c.cid] += 1;
        remainingCapacity[c.cid] -= 1;
        remaining -= 1;
      }
    }
  }

  // 为了稳定性：按 classId、再按 userId/email 排序分配
  const studentsByClass: Record<number, Record<string, string>[]> = {};
  for (const cid of classIds) {
    studentsByClass[cid] = students
      .filter(s => Number(s.classId) === cid)
      .sort((a, b) => (a.userId || a.email).localeCompare(b.userId || b.email));
  }

  // 学生全量池，用于从对应班级依次取人
  const assignedVisitorByEmail = new Map<string, string>();

  for (const t of templateIds) {
    const perClass = perTemplatePerClass[t];
    for (const cid of classIds) {
      const need = perClass[cid] || 0;
      if (need <= 0) continue;
      let picked = 0;
      for (const s of studentsByClass[cid]) {
        if (picked >= need) break;
        if (assignedVisitorByEmail.has(s.email)) continue;
        assignedVisitorByEmail.set(s.email, t);
        picked += 1;
      }
      if (picked < need) {
        throw new Error(`Class ${cid} 不足以满足模板 ${t} 的需求：需要 ${need}，仅分配 ${picked}`);
      }
    }
  }

  // 校验每位学生均被分配且总量匹配
  const assignedCount = Array.from(assignedVisitorByEmail.values()).length;
  if (assignedCount !== students.length) {
    throw new Error(`分配不完整：学生 ${students.length} 人，但仅分配 ${assignedCount} 人`);
  }

  // 统计助教负责模板与学生数
  const assistantTemplates = new Map<string, string[]>(); // email -> [tmpl]
  const assistantStudentCount = new Map<string, number>(); // email -> n
  for (const t of templateIds) {
    const name = templateToAssistantName[t];
    const email = assistantTechByName.get(name);
    if (!email) throw new Error(`未在白名单中找到技术助教：${name}`);
    if (!assistantTemplates.has(email)) assistantTemplates.set(email, []);
    assistantTemplates.get(email)!.push(t);
  }

  // 反向映射：模板→助教email
  const templateToAssistantEmail: Record<string, string> = {};
  for (const [email, tpls] of assistantTemplates.entries()) {
    for (const t of tpls) templateToAssistantEmail[t] = email;
  }

  // 统计助教学生数
  for (const s of students) {
    const t = assignedVisitorByEmail.get(s.email)!;
    const email = templateToAssistantEmail[t];
    assistantStudentCount.set(email, (assistantStudentCount.get(email) || 0) + 1);
  }

  // 生成输出：在原CSV基础上补充字段
  const BASE_HEADERS = ['name','email','userId','classId','role'];
  const EXTRA_HEADERS = ['assignedTechAsst','assignedClassAsst','assignedVisitor','inchargeVisitor','studentCount','status'];
  const headers = [...BASE_HEADERS, ...EXTRA_HEADERS];

  const outRows: Record<string, any>[] = rows.map(r => {
    const base: Record<string, any> = {
      name: r.name || '',
      email: r.email || '',
      userId: r.userId || '',
      classId: r.classId || '',
      role: r.role || '',
      assignedTechAsst: r.assignedTechAsst || '',
      assignedClassAsst: r.assignedClassAsst || '',
      assignedVisitor: r.assignedVisitor || '',
      inchargeVisitor: r.inchargeVisitor || '',
      studentCount: r.studentCount || '',
      status: r.status || 'active',
    };

    if (base.role === 'student') {
      const t = assignedVisitorByEmail.get(base.email);
      if (!t) throw new Error(`学生 ${base.email} 未被分配模板`);
      base.assignedVisitor = normalizeTemplateKey(t); // 写 1..10
      const taEmail = templateToAssistantEmail[base.assignedVisitor];
      base.assignedTechAsst = taEmail; // 用助教email便于 import 脚本匹配
    }

    if (base.role === 'assistant_tech') {
      const tpls = assistantTemplates.get(base.email) || [];
      base.inchargeVisitor = JSON.stringify(tpls.map(normalizeTemplateKey));
      base.studentCount = assistantStudentCount.get(base.email) || 0;
    }

    // 跟班助教/管理员保持原样
    return base;
  });

  const csv = writeCsv(outRows, headers);
  const absOut = path.resolve(outputPath);
  fs.writeFileSync(absOut, csv, 'utf8');

  // 生成一份校验报告到控制台
  const byTplTotal: Record<string, number> = {};
  const byTplByClass: Record<string, Record<number, number>> = {};
  for (const t of templateIds) {
    byTplTotal[t] = 0;
    byTplByClass[t] = {} as any;
    for (const cid of classIds) byTplByClass[t][cid] = 0;
  }
  for (const s of students) {
    const t = assignedVisitorByEmail.get(s.email)!;
    byTplTotal[t] += 1;
    const cid = Number(s.classId);
    byTplByClass[t][cid] += 1;
  }

  console.log('ASSIGNMENT SUMMARY');
  console.log('Total students:', students.length);
  for (const t of templateIds) {
    const perClass = classIds.map(cid => `${cid}:${byTplByClass[t][cid]}`).join(' ');
    console.log(`Template ${t} => total=${byTplTotal[t]} | ${perClass}`);
  }
  console.log('Assistant Loads:');
  for (const [email, cnt] of assistantStudentCount.entries()) {
    console.log(`  ${email} -> ${cnt}`);
  }
  console.log(`CSV written to ${absOut}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


