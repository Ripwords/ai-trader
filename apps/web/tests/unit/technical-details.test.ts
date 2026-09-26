// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import TechnicalDetails from '../../app/components/shared/TechnicalDetails.vue'
import AgentVerdict from '../../app/components/research/AgentVerdict.vue'
import RunCostEstimate from '../../app/components/research/RunCostEstimate.vue'

const RUN_ID = '3f2a9c10-aaaa-bbbb-cccc-1234567890ab'

/** The id appears only inside a closed Technical details disclosure. */
function expectIdOnlyInClosedDisclosure(wrapper: VueWrapper, id: string): void {
  const details = wrapper.find('details[data-testid="technical-details"]')
  expect(details.exists()).toBe(true)
  expect(details.attributes('open')).toBeUndefined()
  expect(details.find('summary').text()).toBe('Technical details')
  expect(details.text()).toContain(id)
  const host = document.createElement('div')
  host.appendChild(wrapper.element.cloneNode(true))
  host.querySelectorAll('details').forEach(d => d.remove())
  expect(host.textContent).not.toContain(id.slice(0, 8))
}

describe('TechnicalDetails', () => {
  it('lists each row inside a closed disclosure', () => {
    const w = mount(TechnicalDetails, { props: { rows: [{ label: 'run id', value: RUN_ID }] } })
    expectIdOnlyInClosedDisclosure(w, RUN_ID)
    expect(w.text()).toContain('run id')
  })

  it('renders nothing without rows', () => {
    const w = mount(TechnicalDetails, { props: { rows: [] } })
    expect(w.find('details').exists()).toBe(false)
  })
})

describe('run ids stay out of the main view', () => {
  it('AgentVerdict', () => {
    const w = mount(AgentVerdict, { props: { rating: 'buy', confidence: 72, rationale: 'because', runId: RUN_ID } })
    expectIdOnlyInClosedDisclosure(w, RUN_ID)
  })

  it('RunCostEstimate in-flight notice', () => {
    const w = mount(RunCostEstimate, {
      props: { symbol: 'NVDA', runHistory: [], inFlight: true, inFlightRunId: RUN_ID },
      global: { stubs: { NuxtLink: { template: '<a><slot /></a>' } } },
    })
    expectIdOnlyInClosedDisclosure(w, RUN_ID)
  })
})
