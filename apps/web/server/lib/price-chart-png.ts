import { Resvg } from '@resvg/resvg-js'

/** SVG → PNG scaled to `widthPx`. The chart SVG carries no text, so no fonts are loaded. */
export function rasterizeSvg(svg: string, widthPx: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: widthPx },
    font: { loadSystemFonts: false },
  })
  return resvg.render().asPng()
}
