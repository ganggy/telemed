import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const fdhEnvPath = 'D:\\fdh_rect\\.env';
if (fs.existsSync(fdhEnvPath)) {
  dotenv.config({ path: fdhEnvPath, override: false });
}

const readFdhBusinessRules = () => {
  const rulesPath = 'D:\\fdh_rect\\server\\config\\business_rules.json';
  if (!fs.existsSync(rulesPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(rulesPath, 'utf8')) as Record<string, any>;
  } catch {
    return {};
  }
};

const businessRules = readFdhBusinessRules();
const TELEMED_ADP_CODE = String(businessRules?.adp_codes?.telmed || 'TELMED').trim().toUpperCase();
const TELEMED_EXPORT_CODE = String(businessRules?.project_codes?.ovstist_tele || '5').trim();
const TELEMED_CLAIM_AMOUNT = 50;
const CIVIL_TARGETS_PATH = path.resolve(process.cwd(), 'data', 'civil-service-targets.json');
const CIVIL_SERVICE_KEYS = ['thai', 'physical', 'dental'] as const;
const CIVIL_RIGHT_KEYS = ['OFC', 'LGO'] as const;
const DEFAULT_CIVIL_VISIT_TARGET = 120;

const pool = mysql.createPool({
  host: process.env.HOSXP_HOST,
  user: process.env.HOSXP_USER,
  password: process.env.HOSXP_PASSWORD,
  database: process.env.HOSXP_DB,
  waitForConnections: true,
  connectionLimit: 12,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: 'utf8mb4',
});

const getConnection = async () => {
  const connection = await pool.getConnection();
  await connection.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
  return connection;
};

const toDateText = (value: unknown, fallback: string) => {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
};

const toNumber = (value: unknown) => {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
};

const toText = (value: unknown) => String(value ?? '').trim();

type CivilTarget = {
  visitEnabled: boolean;
  visitTarget: number;
  amountEnabled: boolean;
  amountTarget: number;
};

const defaultCivilTargets = () => Object.fromEntries(
  CIVIL_SERVICE_KEYS.flatMap((service) => CIVIL_RIGHT_KEYS.map((right) => [
    `${service}:${right}`,
    {
      visitEnabled: true,
      visitTarget: DEFAULT_CIVIL_VISIT_TARGET,
      amountEnabled: false,
      amountTarget: 0,
    },
  ]))
) as Record<string, CivilTarget>;

const readCivilTargets = () => {
  if (!fs.existsSync(CIVIL_TARGETS_PATH)) return {} as Record<string, Record<string, CivilTarget>>;
  try {
    return JSON.parse(fs.readFileSync(CIVIL_TARGETS_PATH, 'utf8')) as Record<string, Record<string, CivilTarget>>;
  } catch {
    return {} as Record<string, Record<string, CivilTarget>>;
  }
};

const getCivilTargetsForMonth = (month: string) => {
  const stored = readCivilTargets()[month] || {};
  const defaults = defaultCivilTargets();
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const target = stored[key];
    return [key, target ? { ...fallback, ...target } : fallback];
  })) as Record<string, CivilTarget>;
};

const writeCivilTargetsForMonth = (month: string, targets: Record<string, CivilTarget>) => {
  const allTargets = readCivilTargets();
  allTargets[month] = targets;
  fs.mkdirSync(path.dirname(CIVIL_TARGETS_PATH), { recursive: true });
  fs.writeFileSync(CIVIL_TARGETS_PATH, `${JSON.stringify(allTargets, null, 2)}\n`, 'utf8');
};

const buildTelemedExistsSql = (visitAlias: string, ovstistAlias: string) => `
  (
    EXISTS (
      SELECT 1
      FROM opitemrece oo
      JOIN s_drugitems d ON d.icode = oo.icode
      WHERE oo.vn = ${visitAlias}.vn
        AND UPPER(COALESCE(d.nhso_adp_code, '')) = '${TELEMED_ADP_CODE}'
      LIMIT 1
    )
    OR COALESCE(${ovstistAlias}.export_code, '') = '${TELEMED_EXPORT_CODE}'
  )
`;

const getTelemedVisitDetail = async (vn: string) => {
  const connection = await getConnection();
  try {
    const [visitRows] = await connection.query(
      `
      SELECT
        o.vn,
        o.hn,
        DATE_FORMAT(o.vstdate, '%Y-%m-%d') AS serviceDate,
        DATE_FORMAT(o.vsttime, '%H:%i') AS serviceTime,
        pt.cid,
        CONCAT(COALESCE(pt.pname, ''), COALESCE(pt.fname, ''), ' ', COALESCE(pt.lname, '')) AS patientName,
        o.pttype,
        COALESCE(ptt.name, '') AS pttypeName,
        COALESCE(ptt.hipdata_code, '') AS hipdataCode,
        COALESCE(ov.export_code, '') AS ovstistExportCode,
        COALESCE(ov.name, '') AS ovstistName,
        COALESCE((SELECT nhso_authen_code FROM nhso_confirm_privilege ncp WHERE ncp.vn = o.vn AND ncp.nhso_status = 'Y' AND ncp.nhso_authen_code REGEXP '^EP' LIMIT 1), '') AS closeEp,
        CASE
          WHEN EXISTS (
            SELECT 1
            FROM opitemrece oo
            JOIN s_drugitems d ON d.icode = oo.icode
            WHERE oo.vn = o.vn
              AND UPPER(COALESCE(d.nhso_adp_code, '')) = '${TELEMED_ADP_CODE}'
            LIMIT 1
          ) THEN ${TELEMED_CLAIM_AMOUNT}
          ELSE 0
        END AS claimAmount,
        COALESCE((SELECT SUM(COALESCE(oo.sum_price, oo.qty * oo.unitprice, 0)) FROM opitemrece oo WHERE oo.vn = o.vn), 0) AS totalAmount
      FROM ovst o
      LEFT JOIN patient pt ON pt.hn = o.hn
      LEFT JOIN pttype ptt ON ptt.pttype = o.pttype
      LEFT JOIN ovstist ov ON ov.ovstist = o.ovstist
      WHERE o.vn = ?
      LIMIT 1
      `,
      [vn]
    );

    const visit = Array.isArray(visitRows) ? (visitRows as Record<string, unknown>[])[0] : null;
    if (!visit) return null;

    const [itemRows] = await connection.query(
      `
      SELECT
        oo.icode,
        COALESCE(sd.name, di.name, ndi.name, oo.icode) AS itemName,
        COALESCE(sd.nhso_adp_code, '') AS nhsoAdpCode,
        oo.income AS incomeCode,
        COALESCE(inc.name, '') AS incomeName,
        COALESCE(oo.qty, 0) AS qty,
        COALESCE(oo.unitprice, 0) AS unitPrice,
        COALESCE(oo.sum_price, oo.qty * oo.unitprice, 0) AS amount,
        CASE
          WHEN di.icode IS NOT NULL THEN 'ยา/เวชภัณฑ์'
          WHEN sd.icode IS NOT NULL THEN 'รายการบริการ/ADP'
          WHEN ndi.icode IS NOT NULL THEN 'ค่าบริการ'
          ELSE 'อื่นๆ'
        END AS itemType,
        CASE WHEN UPPER(COALESCE(sd.nhso_adp_code, '')) = '${TELEMED_ADP_CODE}' THEN 1 ELSE 0 END AS isTelemed
      FROM opitemrece oo
      LEFT JOIN s_drugitems sd ON sd.icode = oo.icode
      LEFT JOIN drugitems di ON di.icode = oo.icode
      LEFT JOIN nondrugitems ndi ON ndi.icode = oo.icode
      LEFT JOIN income inc ON inc.income = oo.income
      WHERE oo.vn = ?
      ORDER BY isTelemed DESC, oo.income, itemName
      `,
      [vn]
    );

    return {
      visit: {
        vn: toText(visit.vn),
        hn: toText(visit.hn),
        serviceDate: toText(visit.serviceDate),
        serviceTime: toText(visit.serviceTime),
        cid: toText(visit.cid),
        patientName: toText(visit.patientName),
        pttype: toText(visit.pttype),
        pttypeName: toText(visit.pttypeName),
        hipdataCode: toText(visit.hipdataCode),
        ovstistExportCode: toText(visit.ovstistExportCode),
        ovstistName: toText(visit.ovstistName),
        closeEp: toText(visit.closeEp),
        claimAmount: toNumber(visit.claimAmount),
        totalAmount: toNumber(visit.totalAmount),
      },
      items: (Array.isArray(itemRows) ? itemRows : []).map((row: any) => ({
        icode: toText(row.icode),
        itemName: toText(row.itemName),
        nhsoAdpCode: toText(row.nhsoAdpCode),
        incomeCode: toText(row.incomeCode),
        incomeName: toText(row.incomeName),
        qty: toNumber(row.qty),
        unitPrice: toNumber(row.unitPrice),
        amount: toNumber(row.amount),
        itemType: toText(row.itemType),
        isTelemed: toNumber(row.isTelemed) === 1,
      })),
    };
  } finally {
    connection.release();
  }
};

const getTelemedDashboardSummary = async (start: string, end: string) => {
  const connection = await getConnection();
  const telemedDetectedSql = buildTelemedExistsSql('o', 'ov');
  const telemedAdpSql = `
    EXISTS (
      SELECT 1
      FROM opitemrece oo
      JOIN s_drugitems d ON d.icode = oo.icode
      WHERE oo.vn = o.vn
        AND UPPER(COALESCE(d.nhso_adp_code, '')) = '${TELEMED_ADP_CODE}'
      LIMIT 1
    )
  `;
  const telemedOvstistSql = `COALESCE(ov.export_code, '') = '${TELEMED_EXPORT_CODE}'`;
  const hasCloseEpSql = `
    (
      COALESCE((SELECT nhso_authen_code FROM nhso_confirm_privilege ncp WHERE ncp.vn = o.vn AND ncp.nhso_status = 'Y' AND ncp.nhso_authen_code REGEXP '^EP' LIMIT 1), '') <> ''
      OR COALESCE((SELECT claim_code FROM authenhos ah WHERE ah.vn = o.vn AND ah.claim_code REGEXP '^EP' LIMIT 1), '') <> ''
      OR COALESCE((SELECT auth_code FROM visit_pttype vp WHERE vp.vn = o.vn AND vp.auth_code REGEXP '^EP' LIMIT 1), '') <> ''
    )
  `;

  try {
    const [rows] = await connection.query(
      `
      SELECT
        o.vn,
        o.hn,
        DATE_FORMAT(o.vstdate, '%Y-%m-%d') AS serviceDate,
        DATE_FORMAT(o.vsttime, '%H:%i') AS serviceTime,
        HOUR(o.vsttime) AS serviceHour,
        pt.cid,
        CONCAT(COALESCE(pt.pname, ''), COALESCE(pt.fname, ''), ' ', COALESCE(pt.lname, '')) AS patientName,
        o.pttype,
        COALESCE(ptt.name, '') AS pttypeName,
        COALESCE(ptt.hipdata_code, '') AS hipdataCode,
        COALESCE(ov.export_code, '') AS ovstistExportCode,
        COALESCE(ov.name, '') AS ovstistName,
        CASE WHEN ${telemedAdpSql} THEN 1 ELSE 0 END AS detectedByAdp,
        CASE WHEN ${telemedOvstistSql} THEN 1 ELSE 0 END AS detectedByOvstist,
        CASE WHEN ${hasCloseEpSql} THEN 1 ELSE 0 END AS hasCloseEp,
        CASE WHEN ${telemedAdpSql} THEN ${TELEMED_CLAIM_AMOUNT} ELSE 0 END AS claimAmount,
        COALESCE((SELECT SUM(COALESCE(oo.sum_price, oo.qty * oo.unitprice, 0)) FROM opitemrece oo WHERE oo.vn = o.vn), 0) AS totalAmount,
        COALESCE((
          SELECT GROUP_CONCAT(DISTINCT COALESCE(sd.name, oo.icode) ORDER BY COALESCE(sd.name, oo.icode) SEPARATOR ', ')
          FROM opitemrece oo
          JOIN s_drugitems sd ON sd.icode = oo.icode
          WHERE oo.vn = o.vn
            AND UPPER(COALESCE(sd.nhso_adp_code, '')) = '${TELEMED_ADP_CODE}'
        ), '') AS telemedItems
      FROM ovst o
      LEFT JOIN patient pt ON pt.hn = o.hn
      LEFT JOIN pttype ptt ON ptt.pttype = o.pttype
      LEFT JOIN ovstist ov ON ov.ovstist = o.ovstist
      WHERE o.vstdate BETWEEN ? AND ?
        AND ${telemedDetectedSql}
      GROUP BY o.vn
      ORDER BY o.vstdate DESC, o.vsttime DESC, o.vn DESC
      LIMIT 20000
      `,
      [start, end]
    );

    const detailRows = (Array.isArray(rows) ? rows : []).map((row: any) => ({
      vn: toText(row.vn),
      hn: toText(row.hn),
      serviceDate: toText(row.serviceDate),
      serviceTime: toText(row.serviceTime),
      serviceHour: toNumber(row.serviceHour),
      cid: toText(row.cid),
      patientName: toText(row.patientName),
      pttype: toText(row.pttype),
      pttypeName: toText(row.pttypeName),
      hipdataCode: toText(row.hipdataCode) || 'ไม่ระบุ',
      ovstistExportCode: toText(row.ovstistExportCode),
      ovstistName: toText(row.ovstistName),
      detectedByAdp: toNumber(row.detectedByAdp) === 1,
      detectedByOvstist: toNumber(row.detectedByOvstist) === 1,
      hasCloseEp: toNumber(row.hasCloseEp) === 1,
      claimAmount: toNumber(row.claimAmount),
      totalAmount: toNumber(row.totalAmount),
      telemedItems: toText(row.telemedItems),
    }));

    const visits = new Set<string>();
    const patients = new Set<string>();
    const byDate = new Map<string, { date: string; visits: number; amount: number; ready: number; pending: number }>();
    const byRight = new Map<string, { key: string; label: string; visits: number; patients: Set<string>; amount: number; ready: number; pending: number }>();
    const byHour = new Map<string, { hour: string; visits: number; amount: number }>();
    const source = { adpOnly: 0, ovstistOnly: 0, both: 0 };
    let totalAmount = 0;
    let totalClaimAmount = 0;
    let closeEpCount = 0;
    let readyCount = 0;

    detailRows.forEach((row) => {
      visits.add(row.vn);
      if (row.hn) patients.add(row.hn);
      totalAmount += row.totalAmount;
      totalClaimAmount += row.claimAmount;
      if (row.hasCloseEp) closeEpCount += 1;
      if (row.hasCloseEp) readyCount += 1;

      if (row.detectedByAdp && row.detectedByOvstist) source.both += 1;
      else if (row.detectedByAdp) source.adpOnly += 1;
      else if (row.detectedByOvstist) source.ovstistOnly += 1;

      const dateKey = row.serviceDate || 'ไม่ระบุวันที่';
      const day = byDate.get(dateKey) || { date: dateKey, visits: 0, amount: 0, ready: 0, pending: 0 };
      day.visits += 1;
      day.amount += row.totalAmount;
      if (row.hasCloseEp) day.ready += 1;
      else day.pending += 1;
      byDate.set(dateKey, day);

      const rightKey = row.hipdataCode || row.pttype || 'ไม่ระบุ';
      const right = byRight.get(rightKey) || {
        key: rightKey,
        label: `${rightKey} ${row.pttypeName || ''}`.trim(),
        visits: 0,
        patients: new Set<string>(),
        amount: 0,
        ready: 0,
        pending: 0,
      };
      right.visits += 1;
      if (row.hn) right.patients.add(row.hn);
      right.amount += row.totalAmount;
      if (row.hasCloseEp) right.ready += 1;
      else right.pending += 1;
      byRight.set(rightKey, right);

      const hourKey = Number.isFinite(row.serviceHour) ? String(row.serviceHour).padStart(2, '0') : 'ไม่ระบุ';
      const hour = byHour.get(hourKey) || { hour: hourKey, visits: 0, amount: 0 };
      hour.visits += 1;
      hour.amount += row.totalAmount;
      byHour.set(hourKey, hour);
    });

    const totalVisits = visits.size;
    const percent = (count: number) => totalVisits > 0 ? Math.round((count / totalVisits) * 100) : 0;

    return {
      startDate: start,
      endDate: end,
      config: {
        source: fs.existsSync(path.resolve(process.cwd(), '.env')) ? 'telemed/.env' : 'fdh_rect/.env fallback',
        telemedAdpCode: TELEMED_ADP_CODE,
        telemedExportCode: TELEMED_EXPORT_CODE,
      },
      summary: {
        totalVisits,
        totalPatients: patients.size,
        totalAmount: Number(totalAmount.toFixed(2)),
        totalClaimAmount: Number(totalClaimAmount.toFixed(2)),
        claimPerCase: TELEMED_CLAIM_AMOUNT,
        readyCount,
        pendingCount: Math.max(totalVisits - readyCount, 0),
        closeEpCount,
        readyRate: percent(readyCount),
        closeRate: percent(closeEpCount),
        averageAmount: totalVisits > 0 ? Number((totalAmount / totalVisits).toFixed(2)) : 0,
      },
      source,
      byDate: [...byDate.values()].map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) })).sort((a, b) => a.date.localeCompare(b.date)),
      byRight: [...byRight.values()]
        .map((row) => ({
          key: row.key,
          label: row.label,
          visits: row.visits,
          patients: row.patients.size,
          amount: Number(row.amount.toFixed(2)),
          ready: row.ready,
          pending: row.pending,
          readyRate: row.visits > 0 ? Math.round((row.ready / row.visits) * 100) : 0,
        }))
        .sort((a, b) => b.visits - a.visits || b.amount - a.amount)
        .slice(0, 12),
      byHour: [...byHour.values()].map((row) => ({ ...row, amount: Number(row.amount.toFixed(2)) })).sort((a, b) => a.hour.localeCompare(b.hour)),
      recent: detailRows.slice(0, 80),
    };
  } finally {
    connection.release();
  }
};

const getCivilServiceSummary = async (start: string, end: string, staffOnly = false) => {
  const connection = await getConnection();
  const staffFilterSql = staffOnly ? `AND staff.cid IS NOT NULL` : '';
  try {
    const [rows] = await connection.query(
      `
      SELECT *
      FROM (
        SELECT
          o.vn,
          o.hn,
          DATE_FORMAT(o.vstdate, '%Y-%m-%d') AS serviceDate,
          DATE_FORMAT(o.vsttime, '%H:%i') AS serviceTime,
          pt.cid,
          CONCAT(COALESCE(pt.pname, ''), COALESCE(pt.fname, ''), ' ', COALESCE(pt.lname, '')) AS patientName,
          o.pttype,
          COALESCE(ptt.name, '') AS pttypeName,
          UPPER(COALESCE(ptt.hipdata_code, '')) AS rightCode,
          CASE WHEN staff.cid IS NOT NULL THEN 1 ELSE 0 END AS isHospitalStaff,
          COALESCE(staff.name, '') AS staffName,
          COALESCE(staff.department, '') AS staffDepartment,
          CASE
            WHEN MAX(CONCAT_WS(' ', COALESCE(sd.name, ''), COALESCE(ndi.name, ''), COALESCE(inc.name, ''))
              REGEXP 'แพทย์แผนไทย|แผนไทย|สมุนไพร|นวดไทย|ประคบ|อบสมุนไพร') = 1 THEN 'thai'
            WHEN MAX(LOWER(CONCAT_WS(' ', COALESCE(sd.name, ''), COALESCE(ndi.name, ''), COALESCE(inc.name, '')))
              REGEXP 'กายภาพ|เวชศาสตร์ฟื้นฟู|ฟื้นฟูสมรรถภาพ|physio') = 1 THEN 'physical'
            WHEN MAX(LOWER(CONCAT_WS(' ', COALESCE(sd.name, ''), COALESCE(ndi.name, ''), COALESCE(inc.name, '')))
              REGEXP 'ทันต|dental|ถอนฟัน|อุดฟัน|ขูดหินปูน') = 1 THEN 'dental'
            ELSE ''
          END AS serviceGroup,
          COALESCE(SUM(COALESCE(oi.sum_price, oi.qty * oi.unitprice, 0)), 0) AS totalAmount,
          COALESCE(GROUP_CONCAT(DISTINCT CASE
            WHEN LOWER(CONCAT_WS(' ', COALESCE(sd.name, ''), COALESCE(ndi.name, ''), COALESCE(inc.name, '')))
              REGEXP 'แพทย์แผนไทย|แผนไทย|สมุนไพร|นวดไทย|ประคบ|อบสมุนไพร|กายภาพ|เวชศาสตร์ฟื้นฟู|ฟื้นฟูสมรรถภาพ|physio|ทันต|dental|ถอนฟัน|อุดฟัน|ขูดหินปูน'
            THEN COALESCE(sd.name, ndi.name, oi.icode)
          END ORDER BY COALESCE(sd.name, ndi.name, oi.icode) SEPARATOR ', '), '') AS serviceItems
        FROM ovst o
        JOIN pttype ptt ON ptt.pttype = o.pttype
        LEFT JOIN patient pt ON pt.hn = o.hn
        LEFT JOIN (
          SELECT TRIM(cid) AS cid, MAX(name) AS name, MAX(department) AS department
          FROM opduser
          WHERE COALESCE(TRIM(cid), '') <> ''
          GROUP BY TRIM(cid)
        ) staff ON staff.cid = TRIM(pt.cid)
        JOIN opitemrece oi ON oi.vn = o.vn
        LEFT JOIN s_drugitems sd ON sd.icode = oi.icode
        LEFT JOIN nondrugitems ndi ON ndi.icode = oi.icode
        LEFT JOIN income inc ON inc.income = oi.income
        WHERE o.vstdate BETWEEN ? AND ?
          AND UPPER(COALESCE(ptt.hipdata_code, '')) IN ('OFC', 'LGO')
          ${staffFilterSql}
        GROUP BY o.vn
      ) civil
      WHERE civil.serviceGroup <> ''
      ORDER BY civil.serviceDate DESC, civil.serviceTime DESC, civil.vn DESC
      LIMIT 20000
      `,
      [start, end]
    );

    const labels: Record<string, string> = {
      thai: 'แพทย์แผนไทย',
      physical: 'กายภาพบำบัด',
      dental: 'ทันตกรรม',
    };
    const detailRows = (Array.isArray(rows) ? rows : []).map((row: any) => ({
      vn: toText(row.vn),
      hn: toText(row.hn),
      serviceDate: toText(row.serviceDate),
      serviceTime: toText(row.serviceTime),
      cid: toText(row.cid),
      patientName: toText(row.patientName),
      pttype: toText(row.pttype),
      pttypeName: toText(row.pttypeName),
      rightCode: toText(row.rightCode),
      hipdataCode: toText(row.rightCode),
      serviceGroup: toText(row.serviceGroup),
      serviceLabel: labels[toText(row.serviceGroup)] || 'ไม่ระบุ',
      serviceItems: toText(row.serviceItems),
      totalAmount: toNumber(row.totalAmount),
      isHospitalStaff: toNumber(row.isHospitalStaff) === 1,
      staffName: toText(row.staffName),
      staffDepartment: toText(row.staffDepartment),
    }));

    const categories = ['thai', 'physical', 'dental'];
    const matrix = categories.map((key) => {
      const categoryRows = detailRows.filter((row) => row.serviceGroup === key);
      const ofcRows = categoryRows.filter((row) => row.rightCode === 'OFC');
      const lgoRows = categoryRows.filter((row) => row.rightCode === 'LGO');
      return {
        key,
        label: labels[key],
        total: categoryRows.length,
        patients: new Set(categoryRows.map((row) => row.hn).filter(Boolean)).size,
        amount: Number(categoryRows.reduce((sum, row) => sum + row.totalAmount, 0).toFixed(2)),
        ofc: {
          visits: ofcRows.length,
          amount: Number(ofcRows.reduce((sum, row) => sum + row.totalAmount, 0).toFixed(2)),
        },
        lgo: {
          visits: lgoRows.length,
          amount: Number(lgoRows.reduce((sum, row) => sum + row.totalAmount, 0).toFixed(2)),
        },
      };
    });

    const byDate = new Map<string, { date: string; ofc: number; lgo: number; total: number }>();
    detailRows.forEach((row) => {
      const day = byDate.get(row.serviceDate) || { date: row.serviceDate, ofc: 0, lgo: 0, total: 0 };
      if (row.rightCode === 'OFC') day.ofc += 1;
      if (row.rightCode === 'LGO') day.lgo += 1;
      day.total += 1;
      byDate.set(row.serviceDate, day);
    });

    const ofcRows = detailRows.filter((row) => row.rightCode === 'OFC');
    const lgoRows = detailRows.filter((row) => row.rightCode === 'LGO');
    const totalAmount = detailRows.reduce((sum, row) => sum + row.totalAmount, 0);

    return {
      startDate: start,
      endDate: end,
      summary: {
        totalVisits: detailRows.length,
        totalPatients: new Set(detailRows.map((row) => row.hn).filter(Boolean)).size,
        totalAmount: Number(totalAmount.toFixed(2)),
        ofcVisits: ofcRows.length,
        ofcAmount: Number(ofcRows.reduce((sum, row) => sum + row.totalAmount, 0).toFixed(2)),
        lgoVisits: lgoRows.length,
        lgoAmount: Number(lgoRows.reduce((sum, row) => sum + row.totalAmount, 0).toFixed(2)),
      },
      matrix,
      byDate: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
      recent: detailRows.slice(0, 100),
    };
  } finally {
    connection.release();
  }
};

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', async (_req, res) => {
  try {
    const connection = await getConnection();
    connection.release();
    res.json({ success: true, database: process.env.HOSXP_DB || null });
  } catch (error) {
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'Database connection failed' });
  }
});

app.get('/api/telemed/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startDate = toDateText(req.query.startDate, today);
    const endDate = toDateText(req.query.endDate, startDate);
    const data = await getTelemedDashboardSummary(startDate, endDate);
    res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/telemed/summary error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'โหลดข้อมูล Telemed ไม่สำเร็จ' });
  }
});

app.get('/api/telemed/visits/:vn', async (req, res) => {
  try {
    const vn = String(req.params.vn || '').trim();
    if (!vn) return res.status(400).json({ success: false, error: 'ต้องระบุ VN' });
    const data = await getTelemedVisitDetail(vn);
    if (!data) return res.status(404).json({ success: false, error: 'ไม่พบข้อมูล Visit' });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/telemed/visits/:vn error:', error);
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'โหลดรายละเอียด Visit ไม่สำเร็จ' });
  }
});

app.get('/api/civil-service/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startDate = toDateText(req.query.startDate, today);
    const endDate = toDateText(req.query.endDate, startDate);
    const staffOnly = String(req.query.staffOnly || '') === '1';
    const data = await getCivilServiceSummary(startDate, endDate, staffOnly);
    res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/civil-service/summary error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'โหลดข้อมูลสิทธิ์ข้าราชการไม่สำเร็จ' });
  }
});

app.get('/api/civil-service/targets', (req, res) => {
  const month = toText(req.query.month);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ success: false, error: 'ต้องระบุเดือนในรูปแบบ YYYY-MM' });
  }
  return res.json({
    success: true,
    data: {
      month,
      defaultVisitTarget: DEFAULT_CIVIL_VISIT_TARGET,
      targets: getCivilTargetsForMonth(month),
    },
  });
});

app.put('/api/civil-service/targets', (req, res) => {
  try {
    const month = toText(req.body?.month);
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ success: false, error: 'ต้องระบุเดือนในรูปแบบ YYYY-MM' });
    }

    const incoming = req.body?.targets && typeof req.body.targets === 'object' ? req.body.targets : {};
    const targets = defaultCivilTargets();
    Object.keys(targets).forEach((key) => {
      const value = incoming[key];
      if (!value || typeof value !== 'object') return;
      const visitTarget = Math.max(toNumber(value.visitTarget), 0);
      const amountTarget = Math.max(toNumber(value.amountTarget), 0);
      targets[key] = {
        visitEnabled: Boolean(value.visitEnabled),
        visitTarget,
        amountEnabled: Boolean(value.amountEnabled),
        amountTarget,
      };
    });

    writeCivilTargetsForMonth(month, targets);
    return res.json({ success: true, data: { month, targets } });
  } catch (error) {
    console.error('PUT /api/civil-service/targets error:', error);
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'บันทึกเป้าหมายไม่สำเร็จ' });
  }
});

const PORT = Number(process.env.TELEMED_PORT) || 3516;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Telemed dashboard API running on http://localhost:${PORT}`);
});
