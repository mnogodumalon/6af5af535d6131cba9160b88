/**
 * Umfrage abschließen — 3-Schritt-Wizard.
 * Steps: 1) Offene Umfrage wählen → 2) Finalen Termin aus den Vorschlägen wählen → 3) Prüfen & schließen.
 * Reads: umfragen, terminvorschlaege. Writes: umfragen (finaler_termin, status=geschlossen).
 * Composes: IntentWizardShell, EntitySelectStep, StepNav, SummaryStep, SuccessStep.
 */
import { useEffect, useState } from 'react';
import { format, parseISO } from 'date-fns';
import { IntentWizardShell, WizardStep } from '@/components/blocks/IntentWizardShell';
import { EntitySelectStep } from '@/components/blocks/EntitySelectStep';
import { SummaryStep } from '@/components/blocks/SummaryStep';
import { SuccessStep } from '@/components/blocks/SuccessStep';
import { fieldText, fieldLookup, fieldDate, fieldRef } from '@/lib/journey';
import { useUmfrageAbschliessenFlow } from '@/lib/journey/flows/UmfrageAbschliessen';
import { tx } from '@/i18n';

function fmt(iso: string | null): string {
  if (!iso) return '';
  try {
    return format(parseISO(iso), 'dd.MM.yyyy HH:mm');
  } catch {
    return iso;
  }
}

export default function UmfrageAbschliessenPage() {
  const [step, setStep] = useState(1);
  const [umfrageId, setUmfrageId] = useState<string | null>(null);

  const flow = useUmfrageAbschliessenFlow({
    steps: { umfragen: 1, finaler_termin: 2 },
    items: {
      umfragen: r => ({
        id: r.id,
        title: fieldText(r, 'titel'),
        subtitle: fieldText(r, 'ort') || undefined,
        status: fieldLookup(r, 'status') ?? undefined,
      }),
      finaler_termin: r => ({
        id: r.id,
        title: tx`${fmt(fieldDate(r, 'beginn'))} – ${fmt(fieldDate(r, 'ende'))}`,
      }),
    },
    where: {
      umfragen: r => fieldLookup(r, 'status')?.key === 'offen',
      finaler_termin: r => Boolean(umfrageId) && fieldRef(r, 'umfrage') === umfrageId,
    },
  });

  const pickedUmfrage = flow.pick('umfragen');
  const pickedTermin = flow.pick('finaler_termin');
  const selectedUmfrage = pickedUmfrage.selectedId ?? null;
  useEffect(() => {
    setUmfrageId(selectedUmfrage);
  }, [selectedUmfrage]);

  const umfrageLabel = selectedUmfrage ? flow.picks.umfragen.labelOf(selectedUmfrage) : undefined;

  return (
    <IntentWizardShell
      title={tx('Umfrage abschließen')}
      currentStep={step}
      onStepChange={setStep}
      forms={flow.formList}
      draftKey={flow.draftKey}
      intro={{
        description: tx('Lege den finalen Termin fest und schließe die Umfrage.'),
        needs: [tx('Eine offene Umfrage mit Terminvorschlägen')],
      }}
    >
      <WizardStep label={tx('Umfrage')} description={tx('Welche offene Umfrage möchtest du abschließen?')}>
        <EntitySelectStep
          {...flow.picks.umfragen.select}
          {...pickedUmfrage}
          avatar="none"
          searchPlaceholder={tx('Titel suchen …')}
          emptyText={tx('Es gibt keine offene Umfrage.')}
        />
      </WizardStep>
      <WizardStep
        label={tx('Finaler Termin')}
        description={
          umfrageLabel
            ? tx`Welcher Terminvorschlag gilt für „${umfrageLabel}“?`
            : tx('Welcher Terminvorschlag gilt?')
        }
        needs={['umfragen']}
      >
        <EntitySelectStep
          {...flow.picks.finaler_termin.select}
          {...pickedTermin}
          avatar="none"
          emptyText={tx('Diese Umfrage hat keine Terminvorschläge.')}
        />
      </WizardStep>
      <WizardStep label={tx('Prüfen')}>
        {!flow.submit.done && (
          <SummaryStep
            forms={flow.formList}
            submit={flow.submit}
            items={[{ key: 'status', label: tx('Status'), value: tx('Geschlossen') }]}
            whatHappensNext={tx('Der Termin wird festgelegt und die Umfrage geschlossen. Du kannst sie danach wieder öffnen.')}
          />
        )}
      </WizardStep>
      {flow.submit.result && (
        <SuccessStep
          result={flow.submit.result}
          forms={flow.formList}
          submit={flow.submit}
          undo={flow.undo}
          next={[
            { label: tx('Neue Umfrage anlegen'), href: '#/intents/umfrage-anlegen' },
            { label: tx('Zum Dashboard'), href: '#/' },
          ]}
        />
      )}
    </IntentWizardShell>
  );
}
