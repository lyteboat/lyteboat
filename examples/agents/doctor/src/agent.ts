/**
 * The doctor agent: its one declaration. The persona is the whole system
 * prompt; there are no skills, so every inherited tool stays away from the
 * model and each doctor tool is always visible; loop requests run at
 * temperature 1 (the default model only takes 1 with thinking on). The tools
 * come from the doctor service's manifest and run on the doctor service
 * (`./tools/doctor-tools.ts`), which fill an argument the model left out
 * from the page the doctor is looking at (`context.page`).
 * @module @lyteboat/agent-doctor/agent
 */

import { lyteboatAgentDef } from '@lyteboat/agent-definition'
import { DOCTOR_PERSONA } from './doctor-persona.ts'
import { doctorClinicalSettingsOf, type DoctorClinicalSettings } from './tools/doctor-clinical-client.ts'
import { readDoctorToolManifest } from './tools/doctor-tool-manifest.ts'
import { doctorTools } from './tools/doctor-tools.ts'

export default lyteboatAgentDef({
  agentId: 'doctor',
  agentName: '临床智研助理',
  persona: { prefix: DOCTOR_PERSONA, complete: true },
  skillDirs: [],
  toolPolicy: { inherited: 'hidden' },
  modelRequest: { temperature: 1 },
  tools: (host) => {
    let settings: DoctorClinicalSettings | undefined
    return doctorTools({
      manifest: readDoctorToolManifest(host.agentPath('assets/doctor-tools.json')),
      settings: () => settings ??= doctorClinicalSettingsOf(process.env),
      templates: host.agentPath('assets/a2ui'),
      a2ui: host.a2ui,
      requestContext: host.requestContext,
      toolPolicy: host.toolPolicy,
    })
  },
})
