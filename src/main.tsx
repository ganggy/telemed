import { StrictMode, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type TelemedRow = {
  vn: string;
  hn: string;
  serviceDate: string;
  serviceTime: string;
  cid: string;
  patientName: string;
  pttype: string;
  pttypeName: string;
  hipdataCode: string;
  ovstistName: string;
  detectedByAdp: boolean;
  detectedByOvstist: boolean;
  hasCloseEp: boolean;
  claimAmount: number;
  totalAmount: number;
  telemedItems: string;
};

type TelemedSummary = {
  startDate: string;
  endDate: string;
  config: { source: string; telemedAdpCode: string; telemedExportCode: string };
  summary: {
    totalVisits: number;
    totalPatients: number;
    totalAmount: number;
    totalClaimAmount: number;
    claimPerCase: number;
    readyCount: number;
    pendingCount: number;
    closeEpCount: number;
    readyRate: number;
    closeRate: number;
    averageAmount: number;
  };
  source: { adpOnly: number; ovstistOnly: number; both: number };
  byDate: Array<{ date: string; visits: number; amount: number; ready: number; pending: number }>;
  byRight: Array<{ key: string; label: string; visits: number; patients: number; amount: number; ready: number; pending: number; readyRate: number }>;
  byHour: Array<{ hour: string; visits: number; amount: number }>;
  recent: TelemedRow[];
};

type VisitDetail = {
  visit: {
    vn: string;
    hn: string;
    serviceDate: string;
    serviceTime: string;
    cid: string;
    patientName: string;
    pttype: string;
    pttypeName: string;
    hipdataCode: string;
    ovstistExportCode: string;
    ovstistName: string;
    closeEp: string;
    claimAmount: number;
    totalAmount: number;
  };
  items: Array<{
    icode: string;
    itemName: string;
    nhsoAdpCode: string;
    incomeCode: string;
    incomeName: string;
    qty: number;
    unitPrice: number;
    amount: number;
    itemType: string;
    isTelemed: boolean;
  }>;
};

type CivilRow = {
  vn: string;
  hn: string;
  serviceDate: string;
  serviceTime: string;
  cid: string;
  patientName: string;
  pttype: string;
  pttypeName: string;
  rightCode: 'OFC' | 'LGO';
  hipdataCode: string;
  serviceGroup: 'thai' | 'physical' | 'dental' | 'emergency' | 'outpatient';
  serviceLabel: string;
  serviceItems: string;
  totalAmount: number;
  isHospitalStaff: boolean;
  staffName: string;
  staffDepartment: string;
};

type CivilSummary = {
  startDate: string;
  endDate: string;
  summary: {
    totalVisits: number;
    totalPatients: number;
    totalAmount: number;
    ofcVisits: number;
    ofcAmount: number;
    lgoVisits: number;
    lgoAmount: number;
  };
  matrix: Array<{
    key: CivilRow['serviceGroup'];
    label: string;
    total: number;
    patients: number;
    amount: number;
    ofc: { visits: number; amount: number };
    lgo: { visits: number; amount: number };
  }>;
  byDate: Array<{ date: string; ofc: number; lgo: number; total: number }>;
  recent: CivilRow[];
};

type CivilTarget = {
  visitEnabled: boolean;
  visitTarget: number;
  amountEnabled: boolean;
  amountTarget: number;
};

type CivilTargetsData = {
  month: string;
  defaultVisitTarget: number;
  targets: Record<string, CivilTarget>;
};

type DrawerRow = Pick<TelemedRow, 'vn' | 'hn' | 'serviceDate' | 'serviceTime' | 'patientName' | 'hipdataCode' | 'totalAmount'> & {
  claimAmount?: number;
};

const today = new Date().toISOString().slice(0, 10);
const currentMonthStart = `${today.slice(0, 7)}-01`;

const emptyData: TelemedSummary = {
  startDate: today,
  endDate: today,
  config: { source: '', telemedAdpCode: '', telemedExportCode: '' },
  summary: {
    totalVisits: 0,
    totalPatients: 0,
    totalAmount: 0,
    totalClaimAmount: 0,
    claimPerCase: 50,
    readyCount: 0,
    pendingCount: 0,
    closeEpCount: 0,
    readyRate: 0,
    closeRate: 0,
    averageAmount: 0,
  },
  source: { adpOnly: 0, ovstistOnly: 0, both: 0 },
  byDate: [],
  byRight: [],
  byHour: [],
  recent: [],
};

const emptyCivilData: CivilSummary = {
  startDate: today,
  endDate: today,
  summary: {
    totalVisits: 0,
    totalPatients: 0,
    totalAmount: 0,
    ofcVisits: 0,
    ofcAmount: 0,
    lgoVisits: 0,
    lgoAmount: 0,
  },
  matrix: [],
  byDate: [],
  recent: [],
};

const serviceMeta = [
  { key: 'thai', label: 'แพทย์แผนไทย' },
  { key: 'physical', label: 'กายภาพบำบัด' },
  { key: 'dental', label: 'ทันตกรรม' },
  { key: 'emergency', label: 'อุบัติเหตุฉุกเฉิน' },
  { key: 'outpatient', label: 'ผู้ป่วยนอก' },
] as const;
const rightMeta = ['OFC', 'LGO'] as const;

const makeDefaultTargets = (month: string): CivilTargetsData => ({
  month,
  defaultVisitTarget: 120,
  targets: Object.fromEntries(serviceMeta.flatMap((service) => rightMeta.map((right) => [
    `${service.key}:${right}`,
    { visitEnabled: true, visitTarget: 120, amountEnabled: false, amountTarget: 0 },
  ]))),
});

const money = (value: number) => `฿${Number(value || 0).toLocaleString('th-TH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

const numberText = (value: number) => Number(value || 0).toLocaleString('th-TH');

const getDefaultApiBaseUrl = () => {
  const { protocol, hostname } = window.location;
  return `${protocol}//${hostname}:3516`;
};

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || getDefaultApiBaseUrl()).replace(/\/$/, '');

const fetchApi = async (path: string, options?: RequestInit) => {
  const response = await fetch(`${apiBaseUrl}${path}`, options);
  const text = await response.text();
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    throw new Error(`API ไม่ได้ส่ง JSON กลับมา กรุณาตรวจว่า telemed-api รันที่ ${apiBaseUrl}`);
  }

  const json = JSON.parse(text);
  if (!response.ok || !json.success) throw new Error(json.error || 'โหลดข้อมูลไม่สำเร็จ');
  return json;
};

function App() {
  const [page, setPage] = useState<'telemed' | 'civil'>('telemed');
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [data, setData] = useState<TelemedSummary>(emptyData);
  const [selected, setSelected] = useState<TelemedRow | null>(null);
  const [detail, setDetail] = useState<VisitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadData = async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ startDate, endDate });
      const json = await fetchApi(`/api/telemed/summary?${query.toString()}`);
      setData(json.data);
      setSelected((current) => current && json.data.recent.some((row: TelemedRow) => row.vn === current.vn) ? current : null);
    } catch (err) {
      setData(emptyData);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const openDetail = async (row: TelemedRow) => {
    setSelected(row);
    setDetail(null);
    setDetailLoading(true);
    try {
      const json = await fetchApi(`/api/telemed/visits/${encodeURIComponent(row.vn)}`);
      setDetail(json.data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const s = data.summary;
  const maxDailyVisits = Math.max(...data.byDate.map((row) => row.visits), 1);
  const maxRightVisits = Math.max(...data.byRight.map((row) => row.visits), 1);
  const maxHourVisits = Math.max(...data.byHour.map((row) => row.visits), 1);
  const closeStop = `${s.closeRate}%`;

  const sourceRows = useMemo(() => {
    const total = Math.max(data.source.adpOnly + data.source.ovstistOnly + data.source.both, 1);
    return [
      { label: 'พบทั้ง ADP และประเภท Visit', value: data.source.both, color: '#00d5ff' },
      { label: 'พบจาก ADP Code', value: data.source.adpOnly, color: '#2f6bff' },
      { label: 'พบจากประเภท Visit', value: data.source.ovstistOnly, color: '#ffb020' },
    ].map((row) => ({ ...row, percent: Math.round((row.value / total) * 100) }));
  }, [data.source]);

  return (
    <div className="app-shell">
      <aside className="brand-rail">
        <div className="brand-mark">HCC</div>
        <div>
          <strong>Hospital Claim</strong>
          <span>Command Center</span>
        </div>
        <nav>
          <button className={page === 'telemed' ? 'active' : ''} onClick={() => setPage('telemed')}>Telemed</button>
          <button className={page === 'civil' ? 'active' : ''} onClick={() => setPage('civil')}>สิทธิ์ข้าราชการ</button>
        </nav>
      </aside>

      {page === 'telemed' ? (
      <main className="dashboard">
        <header className="topbar">
          <div>
            <h1>Telemed Command Center</h1>
            <p>โมดูลติดตามบริการ Telemed ภายใน Hospital Claim Command Center ใช้ดูภาพรวมจาก HOSxP พร้อมคลิกดูรายละเอียดใบสั่งยาและรายการค่าบริการต่อ visit</p>
            <div className="config-line">
              <span>ADP {data.config.telemedAdpCode || '-'}</span>
              <span>Visit export {data.config.telemedExportCode || '-'}</span>
              <span>{data.config.source || '-'}</span>
            </div>
          </div>
          <section className="filters">
            <label>
              <span>วันที่เริ่ม</span>
              <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
            </label>
            <label>
              <span>วันที่สิ้นสุด</span>
              <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
            </label>
            <button onClick={loadData} disabled={loading}>{loading ? 'กำลังโหลด' : 'ดึงข้อมูล'}</button>
          </section>
        </header>

        {error && <div className="alert">{error}</div>}

        <section className="kpi-grid">
          <Metric label="Visit Telemed" value={numberText(s.totalVisits)} detail={`${numberText(s.totalPatients)} ผู้ป่วย`} tone="blue" />
          <Metric label="ยอดเบิก สปสช." value={money(s.totalClaimAmount)} detail={`รวมใบสั่งยา ${money(s.totalAmount)} | TELMED ${money(s.claimPerCase)} / case`} tone="cyan" />
          <Metric label="ปิดสิทธิ์แล้ว" value={`${s.closeRate}%`} detail={`${numberText(s.closeEpCount)} visit พร้อมจาก Close EP`} tone="green" />
          <Metric label="รอปิดสิทธิ์" value={numberText(s.pendingCount)} detail={`${numberText(s.readyCount)} visit ปิดสิทธิ์แล้ว`} tone="amber" />
        </section>

        <section className="layout-main">
          <div className="main-stack">
            <section className="chart-band">
              <Panel title="แนวโน้มรายวัน" subtitle="visit ปิดสิทธิ์แล้วและรอปิดสิทธิ์ในแต่ละวัน" end={`${numberText(s.totalVisits)} visit`}>
                <div className="daily-chart">
                  {data.byDate.map((row) => {
                    const height = Math.max((row.visits / maxDailyVisits) * 188, 8);
                    const readyHeight = row.visits > 0 ? (row.ready / row.visits) * height : 0;
                    return (
                      <div className="day" key={row.date}>
                        <span>{numberText(row.visits)}</span>
                        <div className="day-bar" style={{ height }}><i style={{ height: readyHeight }} /></div>
                        <small>{row.date.slice(5).replace('-', '/')}</small>
                      </div>
                    );
                  })}
                  {data.byDate.length === 0 && <Empty text="ไม่พบข้อมูล Telemed ในช่วงวันที่เลือก" />}
                </div>
              </Panel>

              <Panel title="สถานะปิดสิทธิ์" subtitle="นับเฉพาะ Close EP">
                <div className="donut" style={{ background: `conic-gradient(#14f195 0 ${closeStop}, rgba(255,255,255,0.16) ${closeStop} 100%)` }}>
                  <div><strong>{s.closeRate}%</strong><span>closed</span></div>
                </div>
                <div className="readiness">
                  <div><span>ปิดสิทธิ์แล้ว</span><strong>{numberText(s.closeEpCount)}</strong></div>
                  <div><span>รอปิดสิทธิ์</span><strong>{numberText(s.pendingCount)}</strong></div>
                </div>
              </Panel>
            </section>

            <section className="insight-grid">
              <Panel title="แยกตามสิทธิ์" subtitle="กลุ่มสิทธิ์ที่มี Telemed สูงสุด">
                <div className="right-list">
                  {data.byRight.map((row) => (
                    <div className="right-row" key={row.key}>
                      <div><strong>{row.key}</strong><span>{row.label}</span></div>
                      <em>{numberText(row.visits)}</em>
                      <i style={{ width: `${Math.max((row.visits / maxRightVisits) * 100, 5)}%` }} />
                    </div>
                  ))}
                  {data.byRight.length === 0 && <Empty text="ยังไม่มีข้อมูลสิทธิ์" small />}
                </div>
              </Panel>

              <Panel title="ช่องทางตรวจพบ" subtitle="ADP Code เทียบกับประเภท Visit">
                <div className="source-list">
                  {sourceRows.map((row) => (
                    <div className="source-row" key={row.label}>
                      <div><span style={{ background: row.color }} /><strong>{row.label}</strong></div>
                      <em>{numberText(row.value)} visit</em>
                      <i><b style={{ width: `${row.percent}%`, background: row.color }} /></i>
                    </div>
                  ))}
                </div>
              </Panel>

              <Panel title="ช่วงเวลาบริการ" subtitle="กระจายตามชั่วโมงรับบริการ">
                <div className="hour-chart">
                  {data.byHour.map((row) => (
                    <div key={row.hour}>
                      <span>{row.hour}</span>
                      <i><b style={{ width: `${Math.max((row.visits / maxHourVisits) * 100, 4)}%` }} /></i>
                      <strong>{numberText(row.visits)}</strong>
                    </div>
                  ))}
                  {data.byHour.length === 0 && <Empty text="ยังไม่มีข้อมูลช่วงเวลา" small />}
                </div>
              </Panel>
            </section>

            <Panel title="รายการล่าสุด" subtitle="คลิกแถวเพื่อเปิดรายละเอียดใบสั่งยา" end={`${numberText(data.recent.length)} rows`}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>วันที่ / VN</th>
                      <th>ผู้ป่วย</th>
                      <th>สิทธิ์</th>
                      <th>ช่องทาง</th>
                      <th>สถานะ</th>
                      <th className="right">เบิก สปสช.</th>
                      <th>รายละเอียด</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.map((row) => (
                      <tr key={row.vn} className={selected?.vn === row.vn ? 'selected' : ''} onClick={() => void openDetail(row)}>
                        <td><strong>{row.serviceDate} {row.serviceTime}</strong><span>VN {row.vn} | HN {row.hn}</span></td>
                        <td><strong>{row.patientName || '-'}</strong><span>{row.cid || '-'}</span></td>
                        <td><strong>{row.hipdataCode || '-'}</strong><span>{row.pttypeName || row.pttype || '-'}</span></td>
                        <td>
                          <div className="chip-row">
                            {row.detectedByAdp && <span className="chip blue">ADP</span>}
                            {row.detectedByOvstist && <span className="chip amber">Visit</span>}
                          </div>
                          <small>{row.telemedItems || row.ovstistName || '-'}</small>
                        </td>
                        <td>
                          <div className="chip-row">
                            <span className={`chip ${row.hasCloseEp ? 'green' : 'muted'}`}>{row.hasCloseEp ? 'ปิดสิทธิ์แล้ว' : 'รอปิดสิทธิ์'}</span>
                          </div>
                        </td>
                        <td className="right money"><strong>{money(row.claimAmount)}</strong><span>รวม {money(row.totalAmount)}</span></td>
                        <td><button className="detail-btn" type="button">เปิดรายละเอียด</button></td>
                      </tr>
                    ))}
                    {data.recent.length === 0 && (
                      <tr><td colSpan={7} className="empty-cell">ไม่พบรายการ Telemed ในช่วงวันที่เลือก</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <DetailDrawer row={selected} detail={detail} loading={detailLoading} onClose={() => { setSelected(null); setDetail(null); }} />
        </section>
      </main>
      ) : (
        <CivilServiceMonitor />
      )}
    </div>
  );
}

function CivilServiceMonitor() {
  const loadRequestRef = useRef(0);
  const [scope, setScope] = useState<'all' | 'staff'>('all');
  const [startDate, setStartDate] = useState(currentMonthStart);
  const [endDate, setEndDate] = useState(today);
  const [rightFilter, setRightFilter] = useState<'ALL' | 'OFC' | 'LGO'>('ALL');
  const [serviceFilter, setServiceFilter] = useState<'all' | CivilRow['serviceGroup']>('all');
  const [data, setData] = useState<CivilSummary>(emptyCivilData);
  const [targets, setTargets] = useState<CivilTargetsData>(() => makeDefaultTargets(today.slice(0, 7)));
  const [targetDraft, setTargetDraft] = useState<CivilTargetsData>(() => makeDefaultTargets(today.slice(0, 7)));
  const [showTargets, setShowTargets] = useState(false);
  const [savingTargets, setSavingTargets] = useState(false);
  const [selected, setSelected] = useState<CivilRow | null>(null);
  const [detail, setDetail] = useState<VisitDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const loadData = async (scopeOverride: 'all' | 'staff' = scope) => {
    const requestId = ++loadRequestRef.current;
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ startDate, endDate });
      if (scopeOverride === 'staff') query.set('staffOnly', '1');
      const month = startDate.slice(0, 7);
      const [summaryJson, targetsJson] = await Promise.all([
        fetchApi(`/api/civil-service/summary?${query.toString()}`),
        fetchApi(`/api/civil-service/targets?month=${encodeURIComponent(month)}`),
      ]);
      if (requestId !== loadRequestRef.current) return;
      setData(summaryJson.data);
      setTargets(targetsJson.data);
      setTargetDraft(targetsJson.data);
      setSelected(null);
      setDetail(null);
    } catch (err) {
      if (requestId !== loadRequestRef.current) return;
      setData(emptyCivilData);
      setError((err as Error).message);
    } finally {
      if (requestId === loadRequestRef.current) setLoading(false);
    }
  };

  const switchScope = (nextScope: 'all' | 'staff') => {
    if (nextScope === scope) return;
    setScope(nextScope);
    setSelected(null);
    setDetail(null);
    void loadData(nextScope);
  };

  const openTargets = () => {
    setTargetDraft(structuredClone(targets));
    setShowTargets(true);
  };

  const loadTargetMonth = async (month: string) => {
    setError('');
    try {
      const json = await fetchApi(`/api/civil-service/targets?month=${encodeURIComponent(month)}`);
      setTargetDraft(json.data);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const updateTarget = (key: string, patch: Partial<CivilTarget>) => {
    setTargetDraft((current) => ({
      ...current,
      targets: {
        ...current.targets,
        [key]: { ...current.targets[key], ...patch },
      },
    }));
  };

  const saveTargets = async () => {
    setSavingTargets(true);
    setError('');
    try {
      const json = await fetchApi('/api/civil-service/targets', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ month: targetDraft.month, targets: targetDraft.targets }),
      });
      const saved = { ...targetDraft, targets: json.data.targets };
      if (saved.month === startDate.slice(0, 7)) setTargets(saved);
      setTargetDraft(saved);
      setShowTargets(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingTargets(false);
    }
  };

  const openDetail = async (row: CivilRow) => {
    setSelected(row);
    setDetail(null);
    setDetailLoading(true);
    try {
      const json = await fetchApi(`/api/telemed/visits/${encodeURIComponent(row.vn)}`);
      setDetail(json.data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const filteredRows = useMemo(() => data.recent.filter((row) => (
    (rightFilter === 'ALL' || row.rightCode === rightFilter)
    && (serviceFilter === 'all' || row.serviceGroup === serviceFilter)
  )), [data.recent, rightFilter, serviceFilter]);
  const maxDaily = Math.max(...data.byDate.map((row) => row.total), 1);
  const s = data.summary;

  return (
    <main className="dashboard civil-dashboard">
      <header className="topbar">
        <div>
          <h1>Government Care Monitor</h1>
          <p>{scope === 'staff' ? 'ติดตามการรับบริการของข้าราชการที่เป็นบุคลากรโรงพยาบาล โดยตรวจเลขบัตรประชาชนตรงกับตาราง doctor ที่ Active=Y' : 'ติดตามการรับบริการสิทธิ์ข้าราชการและองค์กรปกครองส่วนท้องถิ่น แยกตามจุดรับบริการ 5 หมวด'}</p>
          <div className="config-line civil-config">
            <span>OFC ข้าราชการ</span>
            <span>LGO อปท.</span>
            <span>ข้อมูลจากใบสั่ง HOSxP</span>
            {scope === 'all' ? <button type="button" className="target-settings-btn" onClick={openTargets}>ตั้งเป้าหมายรายเดือน</button> : null}
          </div>
        </div>
        <section className="filters">
          <label>
            <span>วันที่เริ่ม</span>
            <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
          </label>
          <label>
            <span>วันที่สิ้นสุด</span>
            <input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} />
          </label>
          <button onClick={() => void loadData()} disabled={loading}>{loading ? 'กำลังโหลด' : 'ดึงข้อมูล'}</button>
        </section>
      </header>

      <div className="civil-view-tabs" role="tablist" aria-label="มุมมองสิทธิ์ข้าราชการ">
        <button type="button" role="tab" aria-selected={scope === 'all'} className={scope === 'all' ? 'active' : ''} onClick={() => switchScope('all')}>ภาพรวมข้าราชการ</button>
        <button type="button" role="tab" aria-selected={scope === 'staff'} className={scope === 'staff' ? 'active' : ''} onClick={() => switchScope('staff')}>ข้าราชการในโรงพยาบาล</button>
      </div>

      {error ? <div className="alert">{error}</div> : null}

      <section className="civil-hero-metrics">
        <article className="civil-total">
          <span>{scope === 'staff' ? 'บริการเจ้าหน้าที่ รพ.' : 'บริการทั้งหมด'}</span>
          <strong>{numberText(s.totalVisits)}</strong>
          <small>{numberText(s.totalPatients)} คน | มูลค่า {money(s.totalAmount)}</small>
        </article>
        <article className="civil-right ofc">
          <div><span>OFC</span><small>สิทธิ์ข้าราชการ</small></div>
          <strong>{numberText(s.ofcVisits)} <em>visit</em></strong>
          <b>{money(s.ofcAmount)}</b>
        </article>
        <article className="civil-right lgo">
          <div><span>LGO</span><small>สิทธิ์ อปท.</small></div>
          <strong>{numberText(s.lgoVisits)} <em>visit</em></strong>
          <b>{money(s.lgoAmount)}</b>
        </article>
      </section>

      <section className="civil-category-grid">
        {data.matrix.map((row) => {
          return (
          <button
            type="button"
            key={row.key}
            className={`service-card ${row.key} ${serviceFilter === row.key ? 'selected' : ''}`}
            onClick={() => setServiceFilter((current) => current === row.key ? 'all' : row.key)}
          >
            <div className="service-symbol">{row.key === 'thai' ? 'ท' : row.key === 'physical' ? 'ก' : row.key === 'dental' ? 'ทฟ' : row.key === 'emergency' ? 'ER' : 'OPD'}</div>
            <div className="service-card-head"><strong>{row.label}</strong><span>{numberText(row.total)} visit</span></div>
            <div className="service-split">
              <div>
                <span>OFC</span><strong>{numberText(row.ofc.visits)}</strong><small>{money(row.ofc.amount)}</small>
                {scope === 'all' ? <TargetProgress target={targets.targets[`${row.key}:OFC`]} visits={row.ofc.visits} amount={row.ofc.amount} /> : null}
              </div>
              <div>
                <span>LGO</span><strong>{numberText(row.lgo.visits)}</strong><small>{money(row.lgo.amount)}</small>
                {scope === 'all' ? <TargetProgress target={targets.targets[`${row.key}:LGO`]} visits={row.lgo.visits} amount={row.lgo.amount} /> : null}
              </div>
            </div>
            <footer><span>{numberText(row.patients)} คน</span><strong>{money(row.amount)}</strong></footer>
          </button>
          );
        })}
      </section>

      <section className="civil-overview">
        <Panel title="แนวโน้มการรับบริการ" subtitle="เปรียบเทียบจำนวน visit ของ OFC และ LGO รายวัน" end={`${numberText(s.totalVisits)} visit`}>
          <div className="civil-daily-chart">
            {data.byDate.map((row) => (
              <div className="civil-day" key={row.date}>
                <span>{numberText(row.total)}</span>
                <div className="civil-bars">
                  <i className="ofc-bar" style={{ height: `${Math.max((row.ofc / maxDaily) * 170, row.ofc ? 5 : 0)}px` }} />
                  <i className="lgo-bar" style={{ height: `${Math.max((row.lgo / maxDaily) * 170, row.lgo ? 5 : 0)}px` }} />
                </div>
                <small>{row.date.slice(5).replace('-', '/')}</small>
              </div>
            ))}
            {data.byDate.length === 0 ? <Empty text="ไม่พบข้อมูลในช่วงวันที่เลือก" /> : null}
          </div>
          <div className="chart-legend"><span className="ofc-dot">OFC</span><span className="lgo-dot">LGO</span></div>
        </Panel>

        <Panel title="สัดส่วนตามบริการ" subtitle="จำนวน visit แยกตามหมวดหลัก">
          <div className="civil-service-list">
            {data.matrix.map((row) => (
              <button key={row.key} onClick={() => setServiceFilter(row.key)}>
                <span className={`service-color ${row.key}`} />
                <div><strong>{row.label}</strong><small>{numberText(row.patients)} คน</small></div>
                <b>{numberText(row.total)}</b>
              </button>
            ))}
          </div>
        </Panel>
      </section>

      <div className="civil-list-head">
        <div>
          <h2>รายการรับบริการ</h2>
          <span>คลิกแต่ละรายการเพื่อดูรายละเอียดใบสั่ง</span>
        </div>
        <div className="segment-control">
          {(['ALL', 'OFC', 'LGO'] as const).map((right) => (
            <button key={right} className={rightFilter === right ? 'active' : ''} onClick={() => setRightFilter(right)}>
              {right === 'ALL' ? 'ทั้งหมด' : right}
            </button>
          ))}
        </div>
      </div>

      <section className="layout-main">
        <Panel title="Visit ล่าสุด" subtitle={serviceFilter === 'all' ? 'ทุกหมวดบริการ' : data.matrix.find((row) => row.key === serviceFilter)?.label || ''} end={`${numberText(filteredRows.length)} รายการ`}>
          <div className="table-wrap">
            <table className="civil-table">
              <thead><tr><th>วันที่ / VN</th><th>ผู้รับบริการ</th><th>สิทธิ์</th><th>หมวดบริการ</th><th className="right">มูลค่า</th><th>รายละเอียด</th></tr></thead>
              <tbody>
                {filteredRows.map((row) => (
                  <tr key={row.vn} className={selected?.vn === row.vn ? 'selected' : ''} onClick={() => void openDetail(row)}>
                    <td><strong>{row.serviceDate} {row.serviceTime}</strong><span>VN {row.vn} | HN {row.hn}</span></td>
                    <td>
                      <strong>{row.patientName || '-'}</strong>
                      <span>{row.cid || '-'}</span>
                      {row.isHospitalStaff ? <small className="staff-line">เจ้าหน้าที่ รพ. {row.staffName || ''}{row.staffDepartment ? ` | ${row.staffDepartment}` : ''}</small> : null}
                    </td>
                    <td><span className={`right-badge ${row.rightCode.toLowerCase()}`}>{row.rightCode}</span><small>{row.pttypeName}</small></td>
                    <td><strong>{row.serviceLabel}</strong><span>{row.serviceItems || '-'}</span></td>
                    <td className="right money">{money(row.totalAmount)}</td>
                    <td><button className="detail-btn" type="button">เปิดใบสั่ง</button></td>
                  </tr>
                ))}
                {filteredRows.length === 0 ? <tr><td colSpan={6} className="empty-cell">ไม่พบรายการตามตัวกรอง</td></tr> : null}
              </tbody>
            </table>
          </div>
        </Panel>
        <DetailDrawer row={selected} detail={detail} loading={detailLoading} mode="civil" onClose={() => { setSelected(null); setDetail(null); }} />
      </section>

      {showTargets ? (
        <div className="target-modal-backdrop" role="presentation">
          <section className="target-modal" role="dialog" aria-modal="true" aria-labelledby="target-title">
            <header>
              <div><h2 id="target-title">ตั้งเป้าหมายรายเดือน</h2><p>กำหนดแยกตามหน่วยบริการและสิทธิ์ เปิดใช้เป้า visit ยอดเงิน หรือทั้งสองอย่าง</p></div>
              <button type="button" className="icon-close" onClick={() => setShowTargets(false)} aria-label="ปิด">×</button>
            </header>
            <label className="target-month">
              <span>เดือนเป้าหมาย</span>
              <input type="month" value={targetDraft.month} onChange={(event) => void loadTargetMonth(event.target.value)} />
            </label>
            <div className="target-editor">
              {serviceMeta.map((service) => (
                <section className={`target-unit ${service.key}`} key={service.key}>
                  <h3>{service.label}</h3>
                  {rightMeta.map((right) => {
                    const key = `${service.key}:${right}`;
                    const target = targetDraft.targets[key];
                    return (
                      <div className="target-row" key={key}>
                        <strong className={`right-badge ${right.toLowerCase()}`}>{right}</strong>
                        <label className="target-toggle">
                          <input type="checkbox" checked={target.visitEnabled} onChange={(event) => updateTarget(key, { visitEnabled: event.target.checked })} />
                          <span>จำนวน visit</span>
                        </label>
                        <label className="target-value">
                          <input type="number" min="0" disabled={!target.visitEnabled} value={target.visitTarget} onChange={(event) => updateTarget(key, { visitTarget: Number(event.target.value) })} />
                          <span>visit</span>
                        </label>
                        <label className="target-toggle">
                          <input type="checkbox" checked={target.amountEnabled} onChange={(event) => updateTarget(key, { amountEnabled: event.target.checked })} />
                          <span>ยอดเงิน</span>
                        </label>
                        <label className="target-value">
                          <input type="number" min="0" step="100" disabled={!target.amountEnabled} value={target.amountTarget} onChange={(event) => updateTarget(key, { amountTarget: Number(event.target.value) })} />
                          <span>บาท</span>
                        </label>
                      </div>
                    );
                  })}
                </section>
              ))}
            </div>
            <footer>
              <span>ค่าเริ่มต้น {numberText(targetDraft.defaultVisitTarget)} visit ต่อหน่วย/สิทธิ์</span>
              <div><button type="button" className="secondary-btn" onClick={() => setShowTargets(false)}>ยกเลิก</button><button type="button" className="save-target-btn" disabled={savingTargets} onClick={() => void saveTargets()}>{savingTargets ? 'กำลังบันทึก' : 'บันทึกเป้าหมาย'}</button></div>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}

function TargetProgress({ target, visits, amount }: { target?: CivilTarget; visits: number; amount: number }) {
  if (!target || (!target.visitEnabled && !target.amountEnabled)) {
    return <div className="target-progress disabled">ยังไม่กำหนดเป้า</div>;
  }
  const rows = [
    target.visitEnabled ? { label: `${numberText(visits)}/${numberText(target.visitTarget)} visit`, percent: target.visitTarget > 0 ? (visits / target.visitTarget) * 100 : 0 } : null,
    target.amountEnabled ? { label: `${money(amount)}/${money(target.amountTarget)}`, percent: target.amountTarget > 0 ? (amount / target.amountTarget) * 100 : 0 } : null,
  ].filter(Boolean) as Array<{ label: string; percent: number }>;

  return (
    <div className="target-progress">
      {rows.map((progress) => (
        <div key={progress.label}>
          <span>{progress.label}</span>
          <i><b style={{ width: `${Math.min(Math.max(progress.percent, 0), 100)}%` }} /></i>
          <em>{Math.round(progress.percent)}%</em>
        </div>
      ))}
    </div>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: string; detail: string; tone: string }) {
  return (
    <article className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

function Panel({ title, subtitle, end, children }: { title: string; subtitle: string; end?: string; children: React.ReactNode }) {
  return (
    <section className="panel">
      <div className="section-title">
        <div><h2>{title}</h2><span>{subtitle}</span></div>
        {end && <strong>{end}</strong>}
      </div>
      {children}
    </section>
  );
}

function DetailDrawer({ row, detail, loading, onClose, mode = 'telemed' }: { row: DrawerRow | null; detail: VisitDetail | null; loading: boolean; onClose: () => void; mode?: 'telemed' | 'civil' }) {
  if (!row) {
    return (
      <aside className="detail-drawer detail-empty">
        <div className="drawer-orbit">Rx</div>
        <h2>รายละเอียดใบสั่งยา</h2>
        <p>{mode === 'civil' ? 'เลือก visit จากตารางเพื่อดูรายการค่าบริการและใบสั่งของผู้รับบริการ' : 'เลือก visit จากตารางเพื่อดูรายการค่าบริการ ยา และ ADP Telemed ของแต่ละรายการ'}</p>
      </aside>
    );
  }

  const totalItems = detail?.items.reduce((sum, item) => sum + item.amount, 0) || row.totalAmount;
  const claimAmount = detail?.visit.claimAmount ?? row.claimAmount ?? 0;

  return (
    <aside className="detail-drawer">
      <div className="drawer-head">
        <div>
          <span>รายละเอียดใบสั่งยา</span>
          <h2>{row.patientName || '-'}</h2>
          <p>VN {row.vn} | HN {row.hn}</p>
        </div>
        <button onClick={onClose} aria-label="ปิดรายละเอียด">×</button>
      </div>

      <div className="drawer-summary">
        <div><span>วันที่</span><strong>{row.serviceDate} {row.serviceTime}</strong></div>
        <div><span>สิทธิ์</span><strong>{row.hipdataCode || '-'}</strong></div>
        {mode === 'telemed' ? <div><span>เบิก สปสช.</span><strong>{money(claimAmount)}</strong></div> : null}
        <div><span>ยอดค่าบริการรวม</span><strong>{money(totalItems)}</strong></div>
      </div>

      {loading ? (
        <div className="drawer-loading">กำลังโหลดรายละเอียด...</div>
      ) : (
        <>
          <div className="status-strip">
            <span className={detail?.visit.closeEp ? 'ok' : 'wait'}>{detail?.visit.closeEp ? `ปิดสิทธิ์แล้ว ${detail.visit.closeEp}` : 'รอปิดสิทธิ์'}</span>
          </div>

          <h3>รายการค่าบริการ</h3>
          <div className="rx-list">
            {(detail?.items || []).map((item) => (
              <article className={item.isTelemed ? 'rx-item telemed' : 'rx-item'} key={`${item.icode}-${item.itemName}`}>
                <div>
                  <strong>{item.itemName || item.icode}</strong>
                  <span>{item.itemType} | {item.incomeCode} {item.incomeName}</span>
                  {item.nhsoAdpCode && <em>ADP {item.nhsoAdpCode}{item.isTelemed ? ' | เบิกได้ 50 บาท/case' : ''}</em>}
                </div>
                <div className="rx-price">
                  <strong>{money(item.amount)}</strong>
                  <span>{numberText(item.qty)} x {money(item.unitPrice)}</span>
                </div>
              </article>
            ))}
            {!detail?.items.length && <Empty text="ไม่พบรายการค่าบริการ" small />}
          </div>
        </>
      )}
    </aside>
  );
}

function Empty({ text, small }: { text: string; small?: boolean }) {
  return <div className={`empty ${small ? 'small' : ''}`}>{text}</div>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
