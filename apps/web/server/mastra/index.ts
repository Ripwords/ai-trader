import { Mastra } from '@mastra/core/mastra'
import { analyzeTickerWorkflow } from './workflows/analyze-ticker'

let _mastra: Mastra | null = null

export function getMastra(): Mastra {
  if (!_mastra) {
    _mastra = new Mastra({
      workflows: { analyzeTickerWorkflow },
    })
  }
  return _mastra
}

export { analyzeTickerWorkflow }
