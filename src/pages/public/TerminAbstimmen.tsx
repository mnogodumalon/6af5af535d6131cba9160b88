import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { format, parseISO } from 'date-fns';
import { IconCheck, IconMapPin, IconQuestionMark, IconStar, IconX } from '@tabler/icons-react';
import { PublicShell } from '@/components/PublicShell';
import { Button } from '@/components/ui/button';
import { Bound } from '@/components/blocks/Bound';
import { FieldErrorSummary } from '@/components/blocks/FieldErrorSummary';
import { LoadProblem } from '@/components/blocks/LoadProblem';
import { SuccessStep } from '@/components/blocks/SuccessStep';
import {
  loadPublicPagesConfig, prepareChallenge,
  type PublicPagesConfig, type PublicPageConfig,
} from '@/lib/publicClient';
import {
  useLiveList, useStepForm, useJourneySubmit,
  fieldRef, fieldText, fieldDate, fieldLookup, freshRef,
  type JourneyPort, type JourneyRecord, type PlanStep,
} from '@/lib/journey';
import { createPublicPort } from '@/lib/journey/publicPort';
import { tx } from '@/i18n';

type Answer = 'ja' | 'vielleicht' | 'nein';

function dayLabel(r: JourneyRecord): { day: string; time: string } {
  const iso = fieldDate(r, 'beginn');
  const end = fieldDate(r, 'ende');
  if (!iso) return { day: '—', time: '' };
  const d = parseISO(iso);
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(d);
  const time = format(d, 'HH:mm') + (end ? `–${format(parseISO(end), 'HH:mm')}` : '');
  return { day: `${weekday} ${format(d, 'dd.MM.')}`, time };
}

function AnswerIcon({ a }: { a: string | undefined }) {
  if (a === 'ja') return <IconCheck size={18} className="text-emerald-600" aria-label={tx('Ja')} />;
  if (a === 'vielleicht') return <IconQuestionMark size={18} className="text-amber-600" aria-label={tx('Vielleicht')} />;
  if (a === 'nein') return <IconX size={18} className="text-muted-foreground" aria-label={tx('Nein')} />;
  return <span className="text-muted-foreground">·</span>;
}

function Voting({ cfg, page, port, linkedId }: {
  cfg: PublicPagesConfig; page: PublicPageConfig; port: JourneyPort; linkedId: string;
}) {
  const umfragen = useLiveList(port, 'umfragen', { intervalMs: 0 });
  const termineLive = useLiveList(port, 'terminvorschlaege', { intervalMs: 20000 });
  const antwortenLive = useLiveList(port, 'antworten', { intervalMs: 20000 });
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [missing, setMissing] = useState(false);

  const form = useStepForm('antworten', {
    fields: ['teilnehmer_vorname', 'teilnehmer_nachname'],
    required: { teilnehmer_vorname: true, teilnehmer_nachname: true },
    autoComplete: true,
  });

  const umfrage = umfragen.records.find(r => r.id === linkedId) ?? null;
  const termine = useMemo(
    () => termineLive.records
      .filter(r => fieldRef(r, 'umfrage') === linkedId)
      .sort((a, b) => (fieldDate(a, 'beginn') ?? '').localeCompare(fieldDate(b, 'beginn') ?? '')),
    [termineLive.records, linkedId],
  );
  const antworten = useMemo(
    () => antwortenLive.records
      .filter(r => fieldRef(r, 'umfrage') === linkedId)
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')),
    [antwortenLive.records, linkedId],
  );

  // One row per submission: same full name AND created_at within 10 s of the group's first answer.
  const people = useMemo(() => {
    const groups: { id: string; name: string; start: number; byTermin: Record<string, string> }[] = [];
    const openByName = new Map<string, number[]>();
    for (const r of antworten) {
      const name = `${fieldText(r, 'teilnehmer_vorname')} ${fieldText(r, 'teilnehmer_nachname')}`.trim();
      const key = name.toLowerCase();
      const tid = fieldRef(r, 'terminvorschlag');
      const a = fieldLookup(r, 'antwort')?.key;
      if (!tid || !a) continue;
      const ts = r.createdAt ? Date.parse(r.createdAt) : NaN;
      const idxs = openByName.get(key) ?? [];
      let g = idxs
        .map(i => groups[i])
        .find(x => !Number.isNaN(ts) && !Number.isNaN(x.start) && Math.abs(ts - x.start) <= 10000 && !(tid in x.byTermin));
      if (!g) {
        g = { id: `${key}|${r.id}`, name, start: ts, byTermin: {} };
        groups.push(g);
        idxs.push(groups.length - 1);
        openByName.set(key, idxs);
      }
      g.byTermin[tid] = a;
    }
    return groups;
  }, [antworten]);

  // Every read answer counts exactly once.
  const counts = useMemo(() => {
    const out: Record<string, { ja: number; vielleicht: number }> = {};
    for (const t of termine) out[t.id] = { ja: 0, vielleicht: 0 };
    for (const r of antworten) {
      const tid = fieldRef(r, 'terminvorschlag');
      const a = fieldLookup(r, 'antwort')?.key;
      if (!tid || !out[tid]) continue;
      if (a === 'ja') out[tid].ja += 1;
      else if (a === 'vielleicht') out[tid].vielleicht += 1;
    }
    return out;
  }, [termine, antworten]);

  // Exactly one "Beliebtester": most ja, then most vielleicht, then earliest beginn.
  const bestId = useMemo(() => {
    const ranked = [...termine].sort((a, b) =>
      counts[b.id].ja - counts[a.id].ja
      || counts[b.id].vielleicht - counts[a.id].vielleicht
      || (fieldDate(a, 'beginn') ?? '').localeCompare(fieldDate(b, 'beginn') ?? ''));
    const top = ranked[0];
    return top && (counts[top.id].ja > 0 || counts[top.id].vielleicht > 0) ? top.id : null;
  }, [termine, counts]);

  const closed = !!umfrage && fieldLookup(umfrage, 'status')?.key !== 'offen';
  const finalId = umfrage ? fieldRef(umfrage, 'finaler_termin') : null;
  const finalTermin = finalId ? termine.find(t => t.id === finalId) ?? null : null;

  const firstTerminId = termine[0]?.id;
  const plan: PlanStep[] = termine.map((t, i) => ({
    key: `antwort-${t.id}`,
    entity: 'antworten' as const,
    ...(i === 0 ? { form, primary: true } : {}),
    values: {
      teilnehmer_vorname: form.get('teilnehmer_vorname'),
      teilnehmer_nachname: form.get('teilnehmer_nachname'),
      umfrage: linkedId,
      terminvorschlag: t.id,
      antwort: answers[t.id] ?? 'nein',
    },
  }));

  const submit = useJourneySubmit(port, plan, {
    draftKey: `termin-abstimmen-${linkedId}`,
    onSuccess: () => { setAnswers({}); setMissing(false); },
    check: async () => {
      if (firstTerminId) {
        const ref = await freshRef(port, 'terminvorschlaege', firstTerminId, 'umfrage');
        if (ref !== linkedId) return tx('Inzwischen gehört dieser Termin zu einer anderen Umfrage.');
      }
      const fresh = await port.get('umfragen', linkedId);
      if (!fresh) return tx('Diese Umfrage gibt es nicht mehr.');
      if (fieldLookup(fresh, 'status')?.key !== 'offen') return tx('Die Umfrage ist inzwischen geschlossen.');
      return null;
    },
  });

  if (!umfragen.loaded && umfragen.error) return <LoadProblem onRetry={umfragen.reload} />;
  if (!umfragen.loaded || !termineLive.loaded || !antwortenLive.loaded) {
    if (termineLive.error || antwortenLive.error) {
      return <LoadProblem onRetry={async () => { await termineLive.reload(); await antwortenLive.reload(); }} />;
    }
    return <PublicShell loading />;
  }
  if (!umfrage) {
    return (
      <p className="text-center text-sm text-muted-foreground py-6">
        {tx('Dieser Link passt zu keiner Umfrage. Scanne bitte den QR-Code noch einmal.')}
      </p>
    );
  }

  const canVote = !closed && termine.length > 0 && !submit.result;

  const send = async () => {
    const namesOk = form.validate();
    const allAnswered = termine.every(t => answers[t.id]);
    setMissing(!allAnswered);
    if (!namesOk || !allAnswered) return;
    await submit.run();
  };

  const warmUp = () => {
    const ep = page.endpoints?.find(e => e.op === 'create');
    if (ep) prepareChallenge(cfg, page, 'POST', `/apps/${ep.app_id}/records`);
  };

  const finalLabel = finalTermin ? dayLabel(finalTermin) : null;

  return (
    <div className="space-y-5 min-w-0">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{fieldText(umfrage, 'titel')}</h2>
        {fieldText(umfrage, 'ort') && (
          <p className="flex items-center gap-1 text-sm text-muted-foreground">
            <IconMapPin size={16} className="shrink-0" />{fieldText(umfrage, 'ort')}
          </p>
        )}
        {fieldText(umfrage, 'beschreibung') && (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{fieldText(umfrage, 'beschreibung')}</p>
        )}
      </div>

      {closed && (
        <div className="rounded-2xl bg-primary/10 p-4 text-sm">
          <p className="font-semibold">{tx('Die Umfrage ist geschlossen — abstimmen ist nicht mehr möglich.')}</p>
          {finalLabel ? (
            <p className="mt-1">{tx('Finaler Termin')}: <b>{finalLabel.day} {finalLabel.time}</b></p>
          ) : (
            <p className="mt-1 text-muted-foreground">{tx('Ein finaler Termin wurde noch nicht festgelegt.')}</p>
          )}
        </div>
      )}

      {canVote && (
        <div className="space-y-3" onFocus={warmUp}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Bound form={form} name="teilnehmer_vorname" />
            <Bound form={form} name="teilnehmer_nachname" />
          </div>
        </div>
      )}

      {submit.result && (
        <SuccessStep
          result={submit.result}
          forms={[]}
          submit={submit}
          title={tx('Danke, deine Antwort ist gespeichert')}
          restartLabel={tx('Weitere Person eintragen')}
          actions={{ copy: false, print: false }}
        />
      )}

      {termine.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tx('Für diese Umfrage gibt es noch keine Termine.')}</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-card text-left p-2 max-w-[40vw] font-medium text-muted-foreground">
                  {tx('Name')}
                </th>
                {termine.map(t => {
                  const l = dayLabel(t);
                  const best = t.id === bestId;
                  return (
                    <th
                      key={t.id}
                      className={`p-2 min-w-[5rem] text-center font-medium align-top ${best ? 'bg-primary/10' : ''}`}
                    >
                      <div>{l.day}</div>
                      <div className="text-xs font-normal text-muted-foreground">{l.time}</div>
                      {best && (
                        <div className="mt-1 flex items-center justify-center gap-1 text-xs text-primary">
                          <IconStar size={12} />{tx('Beliebtester')}
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {people.map(p => (
                <tr key={p.id} className="border-t">
                  <td className="sticky left-0 z-10 bg-card p-2 max-w-[40vw] truncate">{p.name}</td>
                  {termine.map(t => (
                    <td key={t.id} className="p-2 text-center">
                      <span className="inline-flex justify-center"><AnswerIcon a={p.byTermin[t.id]} /></span>
                    </td>
                  ))}
                </tr>
              ))}
              {people.length === 0 && (
                <tr className="border-t">
                  <td colSpan={termine.length + 1} className="p-3 text-center text-muted-foreground">
                    {tx('Noch keine Antworten.')}
                  </td>
                </tr>
              )}
              {canVote && (
                <tr className="border-t bg-muted/40">
                  <td className="sticky left-0 z-10 bg-muted p-2 max-w-[40vw] font-medium">{tx('Deine Antwort')}</td>
                  {termine.map(t => (
                    <td key={t.id} className="p-1.5 align-top">
                      <div className="flex flex-col gap-1" role="radiogroup" aria-label={dayLabel(t).day}>
                        {([
                          ['ja', tx('Ja'), 'bg-emerald-600 text-white border-emerald-600'],
                          ['vielleicht', tx('Vielleicht'), 'bg-amber-500 text-white border-amber-500'],
                          ['nein', tx('Nein'), 'bg-foreground/70 text-background border-foreground/70'],
                        ] as const).map(([key, label, on]) => (
                          <button
                            key={key}
                            type="button"
                            role="radio"
                            aria-checked={answers[t.id] === key}
                            onClick={() => setAnswers(a => ({ ...a, [t.id]: key }))}
                            className={`rounded-lg border px-1.5 py-1.5 text-xs font-medium ${answers[t.id] === key ? on : 'bg-card hover:bg-muted'}`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t">
                <td className="sticky left-0 z-10 bg-card p-2 max-w-[40vw] text-xs text-muted-foreground">{tx('Summe')}</td>
                {termine.map(t => (
                  <td key={t.id} className={`p-2 text-center text-xs ${t.id === bestId ?'bg-primary/10' : ''}`}>
                    <div><b>{counts[t.id].ja}</b> {tx('Ja')}</div>
                    <div className="text-muted-foreground"><b>{counts[t.id].vielleicht}</b> {tx('Vielleicht')}</div>
                  </td>
                ))}
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {canVote && (
        <div className="space-y-3">
          <FieldErrorSummary forms={[form]} />
          {missing && (
            <p className="text-sm text-destructive">{tx('Bitte wähle für jeden Termin Ja, Vielleicht oder Nein.')}</p>
          )}
          {submit.offline && (
            <p className="text-sm text-muted-foreground">{tx('Keine Verbindung — deine Eingaben sind gesichert.')}</p>
          )}
          {submit.error && !submit.offline && (
            <p className="text-sm text-destructive">{submit.error.message}</p>
          )}
          <Button type="button" className="w-full" size="lg" disabled={submit.submitting} onClick={send}>
            {submit.submitting ? tx('Wird gespeichert …') : tx('Antwort speichern')}
          </Button>
        </div>
      )}
    </div>
  );
}

export default function TerminAbstimmen() {
  const [searchParams] = useSearchParams();
  const linkedId = searchParams.get('umfrage');
  const [cfg, setCfg] = useState<PublicPagesConfig | null>(null);
  const [page, setPage] = useState<PublicPageConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPublicPagesConfig('termin-abstimmen').then(c => {
      setCfg(c);
      setPage(c?.pages['termin-abstimmen'] ?? null);
      setLoading(false);
    });
  }, []);

  const port = useMemo(() => (cfg && page ? createPublicPort(cfg, page) : null), [cfg, page]);

  if (loading || !cfg || !page || !port) {
    return <PublicShell loading={loading} unavailable={!loading} />;
  }
  return (
    <PublicShell title={page.title} wide>
      {linkedId ? (
        <Voting cfg={cfg} page={page} port={port} linkedId={linkedId} />
      ) : (
        <p className="text-center text-sm text-muted-foreground py-6">
          {tx('Bitte öffne den Link zu deiner Umfrage, den du bekommen hast.')}
        </p>
      )}
    </PublicShell>
  );
}
