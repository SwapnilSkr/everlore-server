/** Sum MPEG audio frames; avoids a transcoding/runtime ffmpeg dependency. */
export function mp3DurationMs(data: Buffer): number {
  let offset = data.subarray(0, 3).toString() === 'ID3' ? 10 + ((data[6] & 127) << 21 | (data[7] & 127) << 14 | (data[8] & 127) << 7 | data[9] & 127) : 0
  let seconds = 0
  while (offset + 4 <= data.length) {
    const h = data.readUInt32BE(offset)
    const version = (h >>> 19) & 3
    const layer = (h >>> 17) & 3
    const bitrateIndex = (h >>> 12) & 15
    const sampleIndex = (h >>> 10) & 3
    if ((h >>> 21) !== 2047 || version === 1 || layer !== 1 || !bitrateIndex || bitrateIndex === 15 || sampleIndex === 3) { offset++; continue }
    const bitrate = (version === 3 ? [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320] : [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160])[bitrateIndex] * 1000
    const sampleRate = [44100,48000,32000][sampleIndex] / (version === 3 ? 1 : version === 2 ? 2 : 4)
    const length = Math.floor((version === 3 ? 144 : 72) * bitrate / sampleRate) + ((h >>> 9) & 1)
    if (offset + length > data.length) break
    seconds += (version === 3 ? 1152 : 576) / sampleRate
    offset += length
  }
  if (!seconds) throw new Error('Invalid speech audio')
  return Math.round(seconds * 1000)
}
