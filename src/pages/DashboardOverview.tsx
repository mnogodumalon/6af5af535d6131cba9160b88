import { useMemo, useState } from 'react';
import { parseISO, format } from 'date-fns';
import { IconCalendarEvent, IconCheck, IconCopy, IconMapPin, IconPlus, IconQrcode, IconStar, IconUsers } from '@tabler/icons-react';
import type { DashboardData } from '@/hooks/useDashboardData';
import { useEntityCrud } from '@/components/EntityCrud';
import { flowActionFor, countOf } from '@/config/plan';
import { INTENTS } from '@/config/intents';
import { extractRecordId } from '@/services/livingAppsService';
import { lookupKey } from '@/lib/formatters';
import { useClock, gruss, namen, undoToast } from '@/lib/polish';
import { tx, appLabel, dateFnsLocale } from '@/i18n';
import { DashboardGrid } from '@/components/DashboardGrid';
import { StatCardRow, StatCard } from '@/components/StatCard';
import { WorkList } from '@/components/WorkList';
import { Button } from '@/components/ui/button';
import { usePublicPageLink } from '@/components/widgets/PublicPageQr';
import { qrSvgString } from '@/components/widgets/QrCode';
import type { EnrichedUmfragen } from '@/types/enriched';

interface SlotTally { id: string; beginn?: string; ende?: string; ja: number; vielleicht: number; nein: number }

function ShareActions({ umfrageId }: { umfrageId: string }) {
  const { link, loading } = usePublicPageLink('umfragen', umfrageId);
  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      undoToast(tx('Link kopiert'));
    } catch {
      window.prompt(tx('Link zur Umfrage'), link);
    }
  };
  const openQr = () => {
    if (!link) return;
    const html = tx`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>QR</title><body style="margin:0;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;padding:16px;box-sizing:border-box"><div style="width:min(80vw,80vh)">${qrSvgString(link).replace(/width="\d+" height="\d+"/, 'width="100%" height="100%"')}</div><p style="word-break:break-all;text-align:center;font-size:14px;color:#555">${link.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p></body>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    window.open(url, '_blank');
  };
  if (!link) return <span className="text-xs text-muted-foreground">{loading ? '' : tx('Teilnahmeseite noch nicht veröffentlicht')}</span>;
  return (
    <div className="flex flex-wrap gap-2">
      <Button type="button" variant="outline" size="sm" onClick={copy}><IconCopy size={16} className="shrink-0" />{tx('Link kopieren')}</Button>
      <Button type="button" variant="outline" size="sm" onClick={openQr}><IconQrcode size={16} className="shrink-0" />{tx('QR-Code öffnen')}</Button>
    </div>
  );
}

export default function DashboardOverview({ data }: { data: DashboardData }) {
  const { terminvorschlaege } = data;
  const clock = useClock();
  const [filter, setFilter] = useState<'all' | 'open' | 'nofinal'>('all');

  const slotsOf = useMemo(() => {
    const map = new Map<string, SlotTally[]>();
    const byId = new Map<string, SlotTally>();
    for (const t of terminvorschlaege) {
      const uid = extractRecordId(t.fields.umfrage);
      if (!uid) continue;
      const s: SlotTally = { id: t.record_id, beginn: t.fields.beginn, ende: t.fields.ende, ja: 0, vielleicht: 0, nein: 0 };
      byId.set(t.record_id, s);
      map.set(uid, [...(map.get(uid) ?? []), s]);
    }
    const answered = new Map<string, Set<string>>();
    for (const a of data.antworten) {
      const sid = extractRecordId(a.fields.terminvorschlag);
      const s = sid ? byId.get(sid) : undefined;
      if (!s) continue;
      const k = lookupKey(a.fields.antwort);
      if (k === 'ja') s.ja++;
      else if (k === 'vielleicht') s.vielleicht++;
      else if (k === 'nein') s.nein++;
      const uid = extractRecordId(a.fields.umfrage);
      if (uid) {
        const key = `${(a.fields.teilnehmer_vorname ?? '').trim().toLowerCase()} ${(a.fields.teilnehmer_nachname ?? '').trim().toLowerCase()}`;
        answered.set(uid, (answered.get(uid) ?? new Set()).add(key));
      }
    }
    for (const list of map.values()) list.sort((x, y) => (x.beginn ?? '').localeCompare(y.beginn ?? ''));
    return { map, people: answered };
  }, [terminvorschlaege, data.antworten]);

  const topSlot = (uid: string): SlotTally | undefined => {
    const list = slotsOf.map.get(uid) ?? [];
    let best: SlotTally | undefined;
    for (const s of list) {
      if (s.ja > 0 && (!best || s.ja > best.ja || (s.ja === best.ja && s.vielleicht > best.vielleicht))) best = s;
    }
    return best;
  };
  const peopleCount = (uid: string) => slotsOf.people.get(uid)?.size ?? 0;
  const closeWith = (u: EnrichedUmfragen) => {
    const top = topSlot(u.record_id);
    return top ? flowActionFor('umfragen', 'finaler_termin', u.record_id, top.id) : null;
  };

  const crud = useEntityCrud(data, {
    footer: (top) => {
      if (top.type !== 'umfragen') return undefined;
      if (lookupKey(top.record.fields.status) !== 'offen') return undefined;
      const go = closeWith(top.record);
      return go ? { label: tx('Besten Termin festlegen & schließen'), onClick: go } : undefined;
    },
  });
  const umfragen = crud.enriched.umfragen;

  const isOpen = (u: EnrichedUmfragen) => lookupKey(u.fields.status) !== 'geschlossen';
  const open = umfragen.filter(isOpen);
  const noFinal = umfragen.filter(u => !u.fields.finaler_termin);
  const ready = open.filter(u => topSlot(u.record_id));
  const noAnswers = open.filter(u => peopleCount(u.record_id) === 0);

  const shown = (filter === 'open' ? open : filter === 'nofinal' ? noFinal : umfragen)
    .slice()
    .sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.createdat.localeCompare(a.createdat));

  const fmtSlot = (s: SlotTally) => {
    if (!s.beginn) return '—';
    const loc = { locale: dateFnsLocale() };
    const b = parseISO(s.beginn);
    const e = s.ende ? parseISO(s.ende) : null;
    const day = format(b, 'EEE, dd.MM.yyyy', loc);
    const from = format(b, 'HH:mm', loc);
    if (!e) return `${day} · ${from}`;
    const to = format(e, format(e, 'yyyy-MM-dd') === format(b, 'yyyy-MM-dd') ? 'HH:mm' : 'dd.MM. HH:mm', loc);
    return `${day} · ${from}–${to}`;
  };
  const slotById = (id: string | null) => terminvorschlaege.find(t => t.record_id === id);

  const createFlow = INTENTS.some(i => i.path === '/intents/umfrage-anlegen');
  const startCreate = () => {
    if (createFlow) window.location.hash = '/intents/umfrage-anlegen';
    else crud.umfragen.openCreate({ status: 'offen' });
  };

  const names = open.map(u => u.fields.titel ?? '');
  const context = umfragen.length === 0
    ? tx('Lege deine erste Terminumfrage an und teile den Link.')
    : ready.length > 0
      ? tx`Bei ${namen(ready.map(u => u.fields.titel ?? ''))} gibt es schon einen Favoriten — du kannst den Termin festlegen.`
      : open.length > 0
        ? tx`Es läuft ${namen(names)} — noch wartet alles auf erste Antworten.`
        : tx('Alle Umfragen sind abgeschlossen.');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{gruss(clock)}</h1>
          <p className="text-sm text-muted-foreground">{context}</p>
        </div>
        {crud.umfragen.canWrite && (
          <Button onClick={startCreate} className="w-full sm:w-auto"><IconPlus size={16} className="shrink-0" />{tx('Neue Umfrage')}</Button>
        )}
      </div>

      {umfragen.length === 0 ? (
        <div className="rounded-[27px] bg-card shadow-sm p-8 flex flex-col items-center gap-3 text-center">
          <IconCalendarEvent size={48} className="text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{tx('Noch keine Umfrage — leg Termine zur Auswahl fest und teile den Link.')}</p>
          {crud.umfragen.canWrite && <Button onClick={startCreate}>{tx('Erste Umfrage anlegen')}</Button>}
        </div>
      ) : (
        <DashboardGrid
          variant="split"
          kpis={
            <StatCardRow>
              <StatCard
                title={tx('Offene Umfragen')}
                value={open.length}
                description={open.length > 0 ? tx`${open.length} mit Abstimmung` : tx('Alles abgeschlossen')}
                icon={<IconUsers size={18} className="text-muted-foreground" />}
                tone={open.length > 0 ? 'primary' : 'default'}
                onClick={() => setFilter(f => f === 'open' ? 'all' : 'open')}
                active={filter === 'open'}
              />
              <StatCard
                title={tx('Ohne finalen Termin')}
                value={noFinal.length}
                description={noFinal.length > 0 ? tx('Termin noch festlegen') : tx('Alles entschieden')}
                icon={<IconCalendarEvent size={18} className="text-muted-foreground" />}
                tone={noFinal.length > 0 ? 'warning' : 'default'}
                onClick={() => setFilter(f => f === 'nofinal' ? 'all' : 'nofinal')}
                active={filter === 'nofinal'}
              />
              <StatCard
                title={tx('Ohne Antworten')}
                value={noAnswers.length}
                description={noAnswers.length > 0 ? tx('Link noch teilen') : tx('Überall wird abgestimmt')}
                icon={<IconQrcode size={18} className="text-muted-foreground" />}
              />
            </StatCardRow>
          }
          aside={
            <WorkList
              title={tx('Bereit zum Festlegen')}
              items={ready.map(u => {
                const top = topSlot(u.record_id)!;
                const go = closeWith(u);
                return {
                  id: u.record_id,
                  title: u.fields.titel ?? '—',
                  secondLine: <span className="text-muted-foreground">{fmtSlot(top)} · {tx`${top.ja} Ja`}</span>,
                  action: go ? { label: tx('Festlegen'), onClick: go } : undefined,
                };
              })}
              onItemClick={id => { const r = data.umfragen.find(x => x.record_id === id); if (r) crud.umfragen.openDetail(r); }}
              empty={{ text: tx('Sobald jemand mit Ja abstimmt, erscheint hier der Favorit.') }}
            />
          }
          primary={
            <div className="space-y-4">
              {shown.map(u => {
                const slots = slotsOf.map.get(u.record_id) ?? [];
                const best = topSlot(u.record_id);
                const finalSlot = slotById(extractRecordId(u.fields.finaler_termin));
                const open_ = isOpen(u);
                const raw = data.umfragen.find(x => x.record_id === u.record_id);
                return (
                  <div key={u.record_id} className="rounded-[27px] bg-card shadow-sm p-4 sm:p-5 space-y-3 overflow-hidden">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => raw && crud.umfragen.openDetail(raw)}
                      >
                        <h3 className="font-semibold truncate">{u.fields.titel ?? '—'}</h3>
                        {u.fields.ort && (
                          <p className="text-sm text-muted-foreground flex items-center gap-1 truncate"><IconMapPin size={14} className="shrink-0" />{u.fields.ort}</p>
                        )}
                      </button>
                      <div className="flex flex-col items-end gap-1 text-sm">
                        <span className={open_ ? 'font-medium text-emerald-600' : 'font-medium text-muted-foreground'}>
                          {open_ ? tx('Offen') : tx('Geschlossen')}
                        </span>
                        <span className="text-muted-foreground">{countOf('antworten', peopleCount(u.record_id), appLabel('antworten'))}</span>
                      </div>
                    </div>

                    {finalSlot && (
                      <p className="text-sm rounded-xl bg-primary/10 px-3 py-2 flex items-center gap-2">
                        <IconCheck size={16} className="shrink-0 text-primary" />
                        <span className="min-w-0">{tx('Finaler Termin')}: <b>{fmtSlot({ id: finalSlot.record_id, beginn: finalSlot.fields.beginn, ende: finalSlot.fields.ende, ja: 0, vielleicht: 0, nein: 0 })}</b></span>
                      </p>
                    )}

                    {slots.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{tx('Noch keine Terminvorschläge.')}</p>
                    ) : (
                      <ul className="divide-y">
                        {slots.map(s => {
                          const isBest = best?.id === s.id;
                          return (
                            <li key={s.id} className={`flex items-center justify-between gap-3 py-2 ${isBest ? 'font-medium' : ''}`}>
                              <span className="min-w-0 flex items-center gap-1.5 text-sm">
                                {isBest && <IconStar size={14} className="shrink-0 text-amber-500" />}
                                <span className="truncate">{fmtSlot(s)}</span>
                              </span>
                              <span className="shrink-0 text-sm">
                                <span className="text-emerald-600">{tx`${s.ja} Ja`}</span>
                                <span className="text-muted-foreground"> · </span>
                                <span className="text-amber-600">{tx`${s.vielleicht} Vielleicht`}</span>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <ShareActions umfrageId={u.record_id} />
                      {open_ && closeWith(u) && (
                        <Button type="button" size="sm" onClick={() => closeWith(u)?.()}>{tx('Besten Termin festlegen')}</Button>
                      )}
                    </div>
                  </div>
                );
              })}
              {shown.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-8">{tx('Keine Umfragen in dieser Ansicht.')}</p>
              )}
            </div>
          }
        />
      )}
      {crud.surfaces}
    </div>
  );
}
