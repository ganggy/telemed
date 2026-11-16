import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import mysql from 'mysql2/promise';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const fdhEnvPath = 'D:\\fdh_rect\\.env';
if (fs.existsSync(fdhEnvPath)) {
  dotenv.config({ path: fdhEnvPath, override: false });
}

// ─── MOPH Provider ID / Health ID Credentials & Config ───────────────────────
const HEALTH_ID_CLIENT_ID = process.env.HEALTH_ID_CLIENT_ID || '01a0faf5-2888-758a-a1c3-d885143cf2e4';
const HEALTH_ID_CLIENT_SECRET = process.env.HEALTH_ID_CLIENT_SECRET || 'a92c05aeec078f4cd9da04d34dd3e5ebe1ea0942';
const PROVIDER_ID_CLIENT_ID = process.env.PROVIDER_ID_CLIENT_ID || '68fdef16-2121-451b-952c-07a9aaf4d1f0';
const PROVIDER_ID_CLIENT_SECRET = process.env.PROVIDER_ID_CLIENT_SECRET || '6bFJzxrV1SnBwEwphUK9vcAPXiWFlzX8';

type UserSession = {
  sessionId: string;
  loginname: string;
  name: string;
  doctorcode: string | null;
  cid: string | null;
  providerProfile: {
    hash_cid?: string;
    name_th?: string;
    organization?: string;
    license_id?: string;
    [key: string]: any;
  };
  loginAt: string;
  expiresAt: number;
};

// In-memory sessions store: sessionId -> UserSession
const activeSessions = new Map<string, UserSession>();

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
const CIVIL_SERVICE_KEYS = ['thai', 'physical', 'dental', 'dialysis', 'emergency', 'outpatient'] as const;
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
            WHEN MAX(CASE
              WHEN o.main_dep = '060'
                OR o.cur_dep = '060'
                OR COALESCE(kd.department, '') REGEXP 'ไตเทียม|ฟอกไต'
                OR oi.income IN ('40', '47')
                OR LOWER(CONCAT_WS(' ', COALESCE(sd.name, ''), COALESCE(ndi.name, ''), COALESCE(inc.name, '')))
                  REGEXP 'ไตเทียม|ฟอกไต|ฟอกเลือด|ล้างไต|hemodialysis|peritoneal dialysis'
              THEN 1 ELSE 0 END) = 1 THEN 'dialysis'
            WHEN MAX(CASE WHEN er.vn IS NOT NULL THEN 1 ELSE 0 END) = 1 THEN 'emergency'
            ELSE 'outpatient'
          END AS serviceGroup,
          COALESCE(SUM(COALESCE(oi.sum_price, oi.qty * oi.unitprice, 0)), 0) AS totalAmount,
          COALESCE(GROUP_CONCAT(DISTINCT CASE
            WHEN COALESCE(sd.name, ndi.name, '') <> ''
            THEN COALESCE(sd.name, ndi.name)
          END ORDER BY COALESCE(sd.name, ndi.name, oi.icode) SEPARATOR ', '), '') AS serviceItems
        FROM ovst o
        JOIN pttype ptt ON ptt.pttype = o.pttype
        LEFT JOIN patient pt ON pt.hn = o.hn
        LEFT JOIN er_regist er ON er.vn = o.vn
        LEFT JOIN kskdepartment kd ON kd.depcode = o.main_dep
        LEFT JOIN (
          SELECT TRIM(cid) AS cid, MAX(name) AS name, '' AS department
          FROM doctor
          WHERE COALESCE(TRIM(cid), '') <> ''
            AND UPPER(COALESCE(Active, '')) = 'Y'
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
      ORDER BY civil.serviceDate DESC, civil.serviceTime DESC, civil.vn DESC
      LIMIT 20000
      `,
      [start, end]
    );

    const labels: Record<string, string> = {
      thai: 'แพทย์แผนไทย',
      physical: 'กายภาพบำบัด',
      dental: 'ทันตกรรม',
      dialysis: 'ไตเทียม',
      emergency: 'อุบัติเหตุฉุกเฉิน',
      outpatient: 'ผู้ป่วยนอก',
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

    const categories = [...CIVIL_SERVICE_KEYS];
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

// ─── PCU (รพ.สต.) ─────────────────────────────────────────────────────────────

type PcuRow = {
  pcucode: string;
  pcuName: string;
  tambol: string;
  villageCount: number;
  villages: string[];
  visits: number;
  patients: number;
  amount: number;
  claimAmount: number;
  closeEpCount: number;
  closeRate: number;
  ofc: number;
  lgo: number;
  uc: number;
  other: number;
};

type PcuVisitRow = {
  vn: string;
  hn: string;
  serviceDate: string;
  serviceTime: string;
  cid: string;
  patientName: string;
  pttype: string;
  pttypeName: string;
  hipdataCode: string;
  pcucode: string;
  pcuName: string;
  addressText: string;
  moopart: string;
  tmbpart: string;
  tmbName: string;
  detectedByAdp: boolean;
  detectedByOvstist: boolean;
  hasCloseEp: boolean;
  claimAmount: number;
  totalAmount: number;
  telemedItems: string;
};

type PcuSummary = {
  startDate: string;
  endDate: string;
  summary: {
    totalVisits: number;
    totalPatients: number;
    totalAmount: number;
    totalClaimAmount: number;
    closeEpCount: number;
    closeRate: number;
    pcuCount: number;
  };
  byPcu: PcuRow[];
  byDate: Array<{ date: string; visits: number; amount: number; claimAmount: number; ready: number; pending: number }>;
  recent: PcuVisitRow[];
};

const PCU_MASTER = [
  {
    code: 'koksri',
    name: 'กลุ่มงานบริการด้านปฐมภูมิฯ (PCU รพ.โคกศรีสุพรรณ)',
    tambol: 'ตองโขบ',
    villageCount: 14,
    villages: [
      'ม.1 บ้านตองโขบ', 'ม.2 บ้านโคก', 'ม.3 บ้านนาสีนวล', 'ม.4 บ้านนามน',
      'ม.5 บ้านหนองแข้', 'ม.7 บ้านห้วยแคน', 'ม.8 บ้านตองโขบน้อย', 'ม.9 บ้านห้วยแคนน้อย',
      'ม.10 บ้านใหม่ศรีสุพรรณ', 'ม.12 บ้านใหม่พัฒนา', 'ม.13 บ้านหนองบัวงาม',
      'ม.14 บ้านโคกศรีสุพรรณ', 'ม.15 บ้านตองโขบเหนือ', 'ม.16 บ้านใหม่นามน'
    ],
  },
  {
    code: 'huayheeb',
    name: 'รพ.สต. บ้านห้วยหีบ',
    tambol: 'ตองโขบ',
    villageCount: 4,
    villages: [
      'ม.6 บ้านห้วยหีบ', 'ม.11 บ้านห้วยหีบเหนือ', 'ม.17 บ้านนาดอย', 'ม.18 บ้านห้วยหีบรุ่งอรุณ'
    ],
  },
  {
    code: 'phonkho',
    name: 'รพ.สต. บ้านโพนค้อ',
    tambol: 'เหล่าโพนค้อ (ทั้งตำบล)',
    villageCount: 11,
    villages: [
      'ม.1 บ้านโพนค้อ', 'ม.2 บ้านเหล่า', 'ม.3 บ้านโคกขี้เหล็ก', 'ม.4 บ้านหนองเหียน',
      'ม.5 บ้านดงคู่', 'ม.6 บ้านดอนส้มโฮง', 'ม.7 บ้านดงสง่า', 'ม.8 บ้านลาดไผ่',
      'ม.9 บ้านโพนค้อเหนือ', 'ม.10 บ้านเหล่าสมบูรณ์', 'ม.11 บ้านเหล่าอุดม'
    ],
  },
  {
    code: 'muangkhai',
    name: 'รพ.สต. บ้านม่วงไข่น้อย',
    tambol: 'ด่านม่วงคำ (ทั้งตำบล)',
    villageCount: 11,
    villages: [
      'ม.1 บ้านด่านม่วงคำ', 'ม.2 บ้านกลาง', 'ม.3 บ้านดานม่วงคำ', 'ม.4 บ้านลาดดู่',
      'ม.5 บ้านม่วงไข่', 'ม.6 บ้านลาดดู่โคก', 'ม.7 บ้านหนองกอม', 'ม.8 บ้านป่าขาว',
      'ม.9 บ้านม่วงไข่น้อย', 'ม.10 บ้านโนนปลาเข็ง', 'ม.11 บ้านด่านพัฒนา'
    ],
  },
  {
    code: 'khoknadi',
    name: 'รพ.สต. บ้านโคกนาดี',
    tambol: 'แมดนาท่ม',
    villageCount: 7,
    villages: [
      'ม.1 บ้านแมด', 'ม.2 บ้านนาท่ม', 'ม.3 บ้านดอนกกยาง', 'ม.5 บ้านหนองผือ',
      'ม.6 บ้านโคกนาดี', 'ม.7 บ้านนาท่มพัฒนา', 'ม.13 บ้านแมดพัฒนา'
    ],
  },
  {
    code: 'phonthong',
    name: 'รพ.สต. บ้านโพนทองวัฒนา',
    tambol: 'แมดนาท่ม',
    villageCount: 6,
    villages: [
      'ม.4 บ้านนาเจริญ', 'ม.8 บ้านโนนน้ำคำ', 'ม.9 บ้านพรหมศรีธาตุ',
      'ม.10 บ้านน้อยดอนปอ', 'ม.11 บ้านโพนทองวัฒนา', 'ม.12 บ้านนาเจริญพัฒนา'
    ],
  },
  {
    code: 'other',
    name: 'นอกเขตรับผิดชอบ / อื่นๆ',
    tambol: 'นอกพื้นที่ / ไม่ระบุหมู่',
    villageCount: 0,
    villages: ['ผู้ป่วยนอกเขตอำเภอโคกศรีสุพรรณ หรือไม่ระบุตำบล/หมู่'],
  },
];

const getPcuSummary = async (start: string, end: string, pcuFilter?: string): Promise<PcuSummary> => {
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
    const pcuCodeExpr = `
      CASE
        -- ตำบลตองโขบ (chw=47, amp=15, tmb=01)
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '01' AND CAST(pt.moopart AS UNSIGNED) IN (6, 11, 17, 18)
          THEN 'huayheeb'
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '01' AND CAST(pt.moopart AS UNSIGNED) IN (1, 2, 3, 4, 5, 7, 8, 9, 10, 12, 13, 14, 15, 16)
          THEN 'koksri'
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '01'
          THEN 'koksri'

        -- ตำบลเหล่าโพนค้อ (chw=47, amp=15, tmb=02 ทั้งตำบล)
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '02'
          THEN 'phonkho'

        -- ตำบลด่านม่วงคำ (chw=47, amp=15, tmb=03 ทั้งตำบล)
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '03'
          THEN 'muangkhai'

        -- ตำบลแมดนาท่ม (chw=47, amp=15, tmb=04)
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '04' AND CAST(pt.moopart AS UNSIGNED) IN (1, 2, 3, 5, 6, 7, 13)
          THEN 'khoknadi'
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '04' AND CAST(pt.moopart AS UNSIGNED) IN (4, 8, 9, 10, 11, 12)
          THEN 'phonthong'
        WHEN pt.chwpart = '47' AND pt.amppart = '15' AND pt.tmbpart = '04'
          THEN 'khoknadi'

        ELSE 'other'
      END
    `;

    const pcuWhere = pcuFilter ? `HAVING pcucode = ?` : '';
    const params: unknown[] = [start, end];
    if (pcuFilter) params.push(pcuFilter);

    const [rows] = await connection.query(
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
        UPPER(COALESCE(ptt.hipdata_code, '')) AS hipdataCode,
        ${pcuCodeExpr} AS pcucode,
        COALESCE(pt.addrpart, '') AS addrpart,
        COALESCE(pt.moopart, '') AS moopart,
        COALESCE(pt.tmbpart, '') AS tmbpart,
        COALESCE(ta.name, '') AS tmbName,
        CASE WHEN ${telemedAdpSql} THEN 1 ELSE 0 END AS detectedByAdp,
        CASE WHEN ${telemedOvstistSql} THEN 1 ELSE 0 END AS detectedByOvstist,
        CASE WHEN ${hasCloseEpSql} THEN 1 ELSE 0 END AS hasCloseEp,
        CASE WHEN ${telemedAdpSql} THEN ${TELEMED_CLAIM_AMOUNT} ELSE 0 END AS claimAmount,
        COALESCE((SELECT SUM(COALESCE(oi.sum_price, oi.qty * oi.unitprice, 0)) FROM opitemrece oi WHERE oi.vn = o.vn), 0) AS totalAmount,
        COALESCE((
          SELECT GROUP_CONCAT(DISTINCT COALESCE(sd.name, oo.icode) ORDER BY COALESCE(sd.name, oo.icode) SEPARATOR ', ')
          FROM opitemrece oo
          JOIN s_drugitems sd ON sd.icode = oo.icode
          WHERE oo.vn = o.vn
            AND UPPER(COALESCE(sd.nhso_adp_code, '')) = '${TELEMED_ADP_CODE}'
        ), '') AS telemedItems
      FROM ovst o
      JOIN patient pt ON pt.hn = o.hn
      LEFT JOIN pttype ptt ON ptt.pttype = o.pttype
      LEFT JOIN ovstist ov ON ov.ovstist = o.ovstist
      LEFT JOIN thaiaddress ta ON ta.chwpart = pt.chwpart AND ta.amppart = pt.amppart AND ta.tmbpart = pt.tmbpart AND ta.codetype = '3'
      WHERE o.vstdate BETWEEN ? AND ?
        AND ${telemedDetectedSql}
      GROUP BY o.vn
      ${pcuWhere}
      ORDER BY o.vstdate DESC, o.vsttime DESC, o.vn DESC
      LIMIT 20000
      `,
      params
    );

    const masterMap = new Map(PCU_MASTER.map((m) => [m.code, m]));

    const detailRows = (Array.isArray(rows) ? rows : []).map((row: any) => {
      const code = toText(row.pcucode) || 'other';
      const master = masterMap.get(code) || masterMap.get('other')!;
      const addrpart = toText(row.addrpart);
      const moopart = toText(row.moopart);
      const tmbName = toText(row.tmbName);

      const addrSegments: string[] = [];
      if (addrpart) addrSegments.push(`บ้านเลขที่ ${addrpart}`);
      if (moopart && Number(moopart) > 0) addrSegments.push(`หมู่ ${Number(moopart)}`);
      if (tmbName) addrSegments.push(`ต.${tmbName}`);
      const addressText = addrSegments.join(' ') || 'ไม่ระบุที่อยู่';

      return {
        vn: toText(row.vn),
        hn: toText(row.hn),
        serviceDate: toText(row.serviceDate),
        serviceTime: toText(row.serviceTime),
        cid: toText(row.cid),
        patientName: toText(row.patientName),
        pttype: toText(row.pttype),
        pttypeName: toText(row.pttypeName),
        hipdataCode: toText(row.hipdataCode),
        pcucode: code,
        pcuName: master.name,
        addressText,
        moopart,
        tmbpart: toText(row.tmbpart),
        tmbName,
        detectedByAdp: toNumber(row.detectedByAdp) === 1,
        detectedByOvstist: toNumber(row.detectedByOvstist) === 1,
        hasCloseEp: toNumber(row.hasCloseEp) === 1,
        claimAmount: toNumber(row.claimAmount),
        totalAmount: toNumber(row.totalAmount),
        telemedItems: toText(row.telemedItems),
      };
    });

    // Aggregate by PCU
    const byPcuMap = new Map<string, {
      pcucode: string; pcuName: string; tambol: string; villageCount: number; villages: string[];
      visits: number; patients: Set<string>; amount: number; claimAmount: number;
      closeEpCount: number; ofc: number; lgo: number; uc: number; other: number;
    }>();

    PCU_MASTER.forEach((m) => {
      byPcuMap.set(m.code, {
        pcucode: m.code,
        pcuName: m.name,
        tambol: m.tambol,
        villageCount: m.villageCount,
        villages: m.villages,
        visits: 0,
        patients: new Set<string>(),
        amount: 0,
        claimAmount: 0,
        closeEpCount: 0,
        ofc: 0,
        lgo: 0,
        uc: 0,
        other: 0,
      });
    });

    const byDateMap = new Map<string, { date: string; visits: number; amount: number; claimAmount: number; ready: number; pending: number }>();
    const allVisits = new Set<string>();
    const allPatients = new Set<string>();
    let totalAmount = 0;
    let totalClaimAmount = 0;
    let totalCloseEp = 0;

    detailRows.forEach((row) => {
      allVisits.add(row.vn);
      if (row.hn) allPatients.add(row.hn);
      totalAmount += row.totalAmount;
      totalClaimAmount += row.claimAmount;
      if (row.hasCloseEp) totalCloseEp += 1;

      const pcu = byPcuMap.get(row.pcucode);
      if (pcu) {
        pcu.visits += 1;
        if (row.hn) pcu.patients.add(row.hn);
        pcu.amount += row.totalAmount;
        pcu.claimAmount += row.claimAmount;
        if (row.hasCloseEp) pcu.closeEpCount += 1;

        if (row.hipdataCode === 'OFC') pcu.ofc += 1;
        else if (row.hipdataCode === 'LGO') pcu.lgo += 1;
        else if (row.hipdataCode === 'UCS' || row.hipdataCode === 'UC' || row.hipdataCode.startsWith('UC')) pcu.uc += 1;
        else pcu.other += 1;
      }

      const day = byDateMap.get(row.serviceDate) || { date: row.serviceDate, visits: 0, amount: 0, claimAmount: 0, ready: 0, pending: 0 };
      day.visits += 1;
      day.amount += row.totalAmount;
      day.claimAmount += row.claimAmount;
      if (row.hasCloseEp) day.ready += 1;
      else day.pending += 1;
      byDateMap.set(row.serviceDate, day);
    });

    const totalVisitCount = allVisits.size;
    const calcRate = (c: number, t: number) => t > 0 ? Math.round((c / t) * 100) : 0;

    return {
      startDate: start,
      endDate: end,
      summary: {
        totalVisits: totalVisitCount,
        totalPatients: allPatients.size,
        totalAmount: Number(totalAmount.toFixed(2)),
        totalClaimAmount: Number(totalClaimAmount.toFixed(2)),
        closeEpCount: totalCloseEp,
        closeRate: calcRate(totalCloseEp, totalVisitCount),
        pcuCount: PCU_MASTER.filter((m) => m.code !== 'other').length,
      },
      byPcu: [...byPcuMap.values()]
        .map((p) => ({
          pcucode: p.pcucode,
          pcuName: p.pcuName,
          tambol: p.tambol,
          villageCount: p.villageCount,
          villages: p.villages,
          visits: p.visits,
          patients: p.patients.size,
          amount: Number(p.amount.toFixed(2)),
          claimAmount: Number(p.claimAmount.toFixed(2)),
          closeEpCount: p.closeEpCount,
          closeRate: calcRate(p.closeEpCount, p.visits),
          ofc: p.ofc,
          lgo: p.lgo,
          uc: p.uc,
          other: p.other,
        }))
        .sort((a, b) => {
          if (a.pcucode === 'other') return 1;
          if (b.pcucode === 'other') return -1;
          return b.visits - a.visits;
        }),
      byDate: [...byDateMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      recent: detailRows.slice(0, 100),
    };
  } finally {
    connection.release();
  }
};

// ─── Express App ───────────────────────────────────────────────────────────────

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

app.get('/api/pcu/summary', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const startDate = toDateText(req.query.startDate, today);
    const endDate = toDateText(req.query.endDate, startDate);
    const pcuFilter = toText(req.query.pcu) || undefined;
    const data = await getPcuSummary(startDate, endDate, pcuFilter);
    res.json({ success: true, data });
  } catch (error) {
    console.error('GET /api/pcu/summary error:', error);
    res.status(500).json({ success: false, error: error instanceof Error ? error.message : 'โหลดข้อมูล รพ.สต. ไม่สำเร็จ' });
  }
});

// ─── MOPH Provider ID Auth Routes ──────────────────────────────────────────

const getCallbackUrl = (req: express.Request) => {
  if (process.env.MOPH_REDIRECT_URI) return process.env.MOPH_REDIRECT_URI;
  const host = req.get('host') || 'localhost:3516';
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${host}/api/auth/moph/callback`;
};

const getFrontendUrl = (req: express.Request) => {
  if (process.env.FRONTEND_URL) return process.env.FRONTEND_URL;
  const hostHeader = req.get('host') || 'localhost:3516';
  const hostname = hostHeader.split(':')[0];
  const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
  return `${proto}://${hostname}:3517`;
};

// Helper: match opduser in HOSxP
const matchOpdUser = async (profile: any) => {
  const connection = await getConnection();
  try {
    const hashCid = String(profile.hash_cid || '').trim();
    const nameTh = String(profile.name_th || '').trim();
    const licenseId = String(profile.license_id || '').trim();

    // 1. ตรวจสอบ hash_cid กับ opduser: SHA2(REPLACE(cid, '-', ''), 256)
    if (hashCid) {
      const [rows]: any = await connection.query(
        `SELECT loginname, name, doctorcode, cid, groupname
         FROM opduser
         WHERE SHA2(REPLACE(cid, '-', ''), 256) = ?
           AND (account_disable IS NULL OR account_disable != 'Y')
         LIMIT 1`,
        [hashCid]
      );
      if (Array.isArray(rows) && rows.length > 0) {
        return { user: rows[0], matchBy: 'hash_cid' };
      }
    }

    // 2. Fallback: จับคู่ด้วย license_id (เลข ว. หรือใบประกอบวิชาชีพ) กับตาราง doctor -> opduser
    if (licenseId) {
      const cleanLicense = licenseId.replace(/[^0-9a-zA-Zก-๙]/g, '');
      const [rows]: any = await connection.query(
        `SELECT o.loginname, o.name, o.doctorcode, o.cid, o.groupname, d.licenseno
         FROM opduser o
         JOIN doctor d ON d.code = o.doctorcode
         WHERE (
           d.licenseno = ?
           OR REPLACE(REPLACE(d.licenseno, '-', ''), ' ', '') = ?
           OR d.licenseno LIKE ?
         )
         AND (o.account_disable IS NULL OR o.account_disable != 'Y')
         LIMIT 1`,
        [licenseId, cleanLicense, `%${cleanLicense}%`]
      );
      if (Array.isArray(rows) && rows.length > 0) {
        return { user: rows[0], matchBy: 'license_id' };
      }
    }

    // 3. Fallback: จับคู่ด้วยชื่อ-นามสกุล (name_th)
    if (nameTh) {
      // ตัดคำนำหน้าทั่วไป (นาย, นาง, นางสาว, นพ., พญ., นายแพทย์, แพทย์หญิง, ทพ., ทพญ., เภสัชกร)
      const cleanName = nameTh
        .replace(/^(นายแพทย์|แพทย์หญิง|นพ\.|พญ\.|ทพ\.|ทพญ\.|ทันตแพทย์|เภสัชกร|ภก\.|ภญ\.|นาย|นางสาว|นาง|\s+)/g, '')
        .trim();
      const parts = cleanName.split(/\s+/).filter(Boolean);
      const firstName = parts[0] || '';
      const lastName = parts[parts.length - 1] || '';

      const [rows]: any = await connection.query(
        `SELECT o.loginname, o.name, o.doctorcode, o.cid, o.groupname
         FROM opduser o
         WHERE (
           o.name LIKE ?
           OR (o.name LIKE ? AND o.name LIKE ?)
         )
         AND (o.account_disable IS NULL OR o.account_disable != 'Y')
         LIMIT 1`,
        [`%${cleanName}%`, `%${firstName}%`, `%${lastName}%`]
      );
      if (Array.isArray(rows) && rows.length > 0) {
        return { user: rows[0], matchBy: 'name_th' };
      }
    }

    return null;
  } finally {
    connection.release();
  }
};

// Step 1: Redirect Login URL
app.get('/api/auth/moph/login', (req, res) => {
  const callbackUrl = getCallbackUrl(req);
  const mophLoginUrl = `https://moph.id.th/oauth/redirect?client_id=${encodeURIComponent(HEALTH_ID_CLIENT_ID)}&redirect_uri=${encodeURIComponent(callbackUrl)}&response_type=code`;
  res.redirect(mophLoginUrl);
});

// Step 2, 3, 4: OAuth Callback
app.get('/api/auth/moph/callback', async (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const code = toText(req.query.code);
  const errorParam = toText(req.query.error || req.query.error_description);
  const frontendUrl = getFrontendUrl(req);

  if (errorParam || !code) {
    const errorMsg = errorParam || 'ไม่พบ authorization code จากระบบหมอพร้อม (MOPH ID)';
    return res.status(400).send(`
      <!DOCTYPE html>
      <html lang="th">
      <head>
        <meta charset="utf-8">
        <title>เข้าสู่ระบบไม่สำเร็จ</title>
        <style>
          body { font-family: 'Noto Sans Thai', sans-serif; background: #f0f7fb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: white; padding: 32px; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.1); max-width: 440px; text-align: center; }
          h2 { color: #dc2626; margin-top: 0; }
          p { color: #475569; line-height: 1.6; }
          a { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #0284c7; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>เข้าสู่ระบบไม่สำเร็จ</h2>
          <p>${errorMsg}</p>
          <a href="${frontendUrl}">กลับสู่หน้าหลัก</a>
        </div>
      </body>
      </html>
    `);
  }

  const userAgent = req.get('user-agent') || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const callbackUrl = getCallbackUrl(req);

  try {
    // Step 2: Exchange Health ID Token
    const healthTokenRes = await fetch('https://moph.id.th/api/v1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify({
        client_id: HEALTH_ID_CLIENT_ID,
        client_secret: HEALTH_ID_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
      }),
    });

    const healthTokenJson: any = await healthTokenRes.json();
    const healthAccessToken = healthTokenJson?.data?.access_token || healthTokenJson?.access_token;

    if (!healthAccessToken) {
      console.error('Health ID Token Exchange Failed:', healthTokenJson);
      throw new Error(healthTokenJson?.message || healthTokenJson?.error || 'ไม่สามารถขอ Health ID Access Token ได้');
    }

    // Step 3: Exchange Provider ID Token
    const providerTokenRes = await fetch('https://provider.id.th/api/v1/services/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
      },
      body: JSON.stringify({
        client_id: PROVIDER_ID_CLIENT_ID,
        secret_key: PROVIDER_ID_CLIENT_SECRET,
        token_by: 'Health ID',
        token: healthAccessToken,
      }),
    });

    const providerTokenJson: any = await providerTokenRes.json();
    const providerAccessToken = providerTokenJson?.data?.access_token || providerTokenJson?.access_token;

    if (!providerAccessToken) {
      console.error('Provider ID Token Exchange Failed:', providerTokenJson);
      throw new Error(providerTokenJson?.message || providerTokenJson?.error || 'ไม่สามารถขอ Provider ID Token ได้');
    }

    // Step 4: Get Provider Profile
    const profileRes = await fetch('https://provider.id.th/api/v1/services/profile', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${providerAccessToken}`,
        'client-id': PROVIDER_ID_CLIENT_ID,
        'secret-key': PROVIDER_ID_CLIENT_SECRET,
        'User-Agent': userAgent,
      },
    });

    const profileJson: any = await profileRes.json();
    const profile = profileJson?.data || profileJson;

    if (!profile || (!profile.hash_cid && !profile.name_th && !profile.cid)) {
      console.error('Get Provider Profile Failed:', profileJson);
      throw new Error(profileJson?.message || 'ไม่สามารถดึงข้อมูล Provider Profile จากระบบหมอพร้อมได้');
    }

    // Step 5: จับคู่ผู้ใช้งานกับฐานข้อมูล HOSxP (opduser)
    const matchResult = await matchOpdUser(profile);

    if (!matchResult) {
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="th">
        <head>
          <meta charset="utf-8">
          <title>ไม่พบข้อมูลผู้ใช้งานในระบบ HOSxP</title>
          <style>
            body { font-family: 'Noto Sans Thai', sans-serif; background: #f0f7fb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
            .card { background: white; padding: 32px; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.1); max-width: 500px; text-align: center; }
            h2 { color: #d97706; margin-top: 0; }
            p { color: #475569; line-height: 1.6; font-size: 0.95rem; }
            .info-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin: 16px 0; text-align: left; font-size: 0.88rem; }
            a { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #0284c7; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; }
          </style>
        </head>
        <body>
          <div class="card">
            <h2>ไม่พบสิทธิ์การใช้งานใน HOSxP</h2>
            <p>ยืนยันตัวตนผ่านหมอพร้อม (MOPH Provider ID) สำเร็จแล้ว แต่ไม่พบข้อมูลผู้ใช้งานที่เชื่อมโยงในตารางผู้ใช้งาน (opduser) ของโรงพยาบาลโคกศรีสุพรรณ</p>
            <div class="info-box">
              <div><strong>ชื่อจากหมอพร้อม:</strong> ${profile.name_th || '-'}</div>
              <div><strong>หน่วยงาน:</strong> ${profile.organization || 'รพ.โคกศรีสุพรรณ'}</div>
              <div><strong>เลข ว./ใบอนุญาต:</strong> ${profile.license_id || '-'}</div>
            </div>
            <p>กรุณาติดต่อผู้ดูแลระบบเพื่อตรวจสอบการลงทะเบียนเลขบัตรประชาชน (CID) ในระบบ HOSxP</p>
            <a href="${frontendUrl}">กลับสู่หน้าหลัก</a>
          </div>
        </body>
        </html>
      `);
    }

    // Step 6: สร้าง Session และบันทึก
    const sessionId = crypto.randomBytes(32).toString('hex');
    const userSession: UserSession = {
      sessionId,
      loginname: matchResult.user.loginname,
      name: matchResult.user.name,
      doctorcode: matchResult.user.doctorcode || null,
      cid: matchResult.user.cid || null,
      providerProfile: {
        hash_cid: profile.hash_cid,
        name_th: profile.name_th,
        organization: profile.organization,
        license_id: profile.license_id,
      },
      loginAt: new Date().toISOString(),
      expiresAt: Date.now() + (24 * 60 * 60 * 1000), // 24 ชั่วโมง
    };

    activeSessions.set(sessionId, userSession);

    // Redirect เข้าสู่หน้าหลักของแอปพลิเคชัน พร้อมส่ง Session Token ทาง HTML localStorage
    return res.send(`
      <!DOCTYPE html>
      <html lang="th">
      <head>
        <meta charset="utf-8">
        <title>กำลังเข้าสู่ระบบ...</title>
      </head>
      <body>
        <p style="font-family: sans-serif; text-align: center; margin-top: 50px;">กำลังเข้าสู่ระบบ Hospital Claim Command Center...</p>
        <script>
          try {
            localStorage.setItem('hcc_auth_session', JSON.stringify(${JSON.stringify(userSession)}));
            localStorage.setItem('hcc_session_id', ${JSON.stringify(sessionId)});
          } catch (e) {
            console.error('Storage error', e);
          }
          window.location.href = ${JSON.stringify(frontendUrl)};
        </script>
      </body>
      </html>
    `);

  } catch (err: any) {
    console.error('MOPH OAuth Flow Error:', err);
    return res.status(500).send(`
      <!DOCTYPE html>
      <html lang="th">
      <head>
        <meta charset="utf-8">
        <title>เกิดข้อผิดพลาดในการเชื่อมต่อ</title>
        <style>
          body { font-family: 'Noto Sans Thai', sans-serif; background: #f0f7fb; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
          .card { background: white; padding: 32px; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,0.1); max-width: 480px; text-align: center; }
          h2 { color: #dc2626; margin-top: 0; }
          p { color: #475569; line-height: 1.6; }
          .err { background: #fef2f2; border: 1px solid #fee2e2; padding: 10px; border-radius: 6px; color: #991b1b; font-size: 0.85rem; word-break: break-all; margin: 12px 0; }
          a { display: inline-block; margin-top: 16px; padding: 10px 20px; background: #0284c7; color: white; text-decoration: none; border-radius: 6px; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>เกิดข้อผิดพลาดในการเชื่อมต่อ</h2>
          <p>ไม่สามารถแลกเปลี่ยนข้อมูลกับระบบกระทรวงสาธารณสุขได้ในขณะนี้</p>
          <div class="err">${err?.message || 'Unknown error'}</div>
          <a href="${frontendUrl}">กลับสู่หน้าหลัก</a>
        </div>
      </body>
      </html>
    `);
  }
});

// Endpoint: ดึงข้อมูล Session ปัจจุบัน
app.get('/api/auth/session', (req, res) => {
  const sessionId = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.sessionId as string;
  if (!sessionId || !activeSessions.has(sessionId)) {
    return res.json({ success: true, authenticated: false, user: null });
  }

  const session = activeSessions.get(sessionId)!;
  if (Date.now() > session.expiresAt) {
    activeSessions.delete(sessionId);
    return res.json({ success: true, authenticated: false, user: null, message: 'Session หมดอายุ' });
  }

  return res.json({
    success: true,
    authenticated: true,
    user: {
      loginname: session.loginname,
      name: session.name,
      doctorcode: session.doctorcode,
      providerProfile: session.providerProfile,
      loginAt: session.loginAt,
    },
  });
});

// Endpoint: ออกจากระบบ
app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.body?.sessionId;
  if (sessionId && activeSessions.has(sessionId)) {
    activeSessions.delete(sessionId);
  }
  res.json({ success: true, message: 'ออกจากระบบสำเร็จ' });
});

const PORT = Number(process.env.TELEMED_PORT) || 3516;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Telemed dashboard API running on http://localhost:${PORT}`);
});
