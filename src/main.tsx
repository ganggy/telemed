import { StrictMode, useEffect, useMemo, useState } from 'react';
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

const today = new Date().toISOString().slice(0, 10);

const emptyData: TelemedSummary = {
  startDate: today,
  endDate: today,
  config: { source: '', telemedAdpCode: '', telemedExportCode: '' },
  summary: {
    totalVisits: 0,
    totalPatients: 0,
    totalAmount: 0,
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

const money = (value: number) => `฿${Number(value || 0).toLocaleString('th-TH', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

const numberText = (value: number) => Number(value || 0).toLocaleString('th-TH');

function App() {
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
      const response = await fetch(`/api/telemed/summary?${query.toString()}`);
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error || 'โหลดข้อมูลไม่สำเร็จ');
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
      const response = await fetch(`/api/telemed/visits/${encodeURIComponent(row.vn)}`);
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error || 'โหลดรายละเอียดไม่สำเร็จ');
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
        <div className="brand-mark">TM</div>
        <div>
          <strong>Telemed</strong>
          <span>Command</span>
        </div>
        <nav>
          <a className="active">Dashboard</a>
          <a>Claims</a>
          <a>Visit Detail</a>
          <a>Readiness</a>
        </nav>
      </aside>

      <main className="dashboard">
        <header className="topbar">
          <div>
            <h1>Telemed Command Center</h1>
            <p>ระบบแยกสำหรับผู้บริหาร ใช้ดูภาพรวมบริการ Telemed จาก HOSxP พร้อมคลิกดูรายละเอียดใบสั่งยาและรายการค่าบริการต่อ visit</p>
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
          <Metric label="มูลค่าค่าบริการ" value={money(s.totalAmount)} detail={`เฉลี่ย ${money(s.averageAmount)} / visit`} tone="cyan" />
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
                      <th className="right">ยอดเงิน</th>
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
                        <td className="right money">{money(row.totalAmount)}</td>
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

function DetailDrawer({ row, detail, loading, onClose }: { row: TelemedRow | null; detail: VisitDetail | null; loading: boolean; onClose: () => void }) {
  if (!row) {
    return (
      <aside className="detail-drawer detail-empty">
        <div className="drawer-orbit">Rx</div>
        <h2>รายละเอียดใบสั่งยา</h2>
        <p>เลือก visit จากตารางเพื่อดูรายการค่าบริการ ยา และ ADP Telemed ของแต่ละรายการ</p>
      </aside>
    );
  }

  const totalItems = detail?.items.reduce((sum, item) => sum + item.amount, 0) || row.totalAmount;

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
        <div><span>ยอดรวม</span><strong>{money(totalItems)}</strong></div>
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
                  {item.nhsoAdpCode && <em>ADP {item.nhsoAdpCode}</em>}
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
