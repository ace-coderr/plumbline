/**
 * Minimal MP4 writer for one H.264 video track: ftyp, moov (index first, so players can start
 * before the whole file arrives), then mdat. Samples are length-prefixed NAL units in decode order,
 * as WebCodecs' VideoEncoder emits with avc.format "avc"; `avcC` is its decoderConfig.description.
 * Constant frame rate and no frame reordering (the encoder emits no B-frames), so no ctts box.
 */

const u8 = (n) => Buffer.from([n & 0xff]);
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
const zeros = (n) => Buffer.alloc(n);
const str = (s) => Buffer.from(s, "latin1");

function box(type, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u32(8 + body.length), str(type), body]);
}
const full = (type, version, flags, ...parts) => box(type, u8(version), u8(flags >> 16), u16(flags & 0xffff), ...parts);

// Unity transform matrix, 16.16 and 2.30 fixed point.
const MATRIX = Buffer.concat([0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32));

/**
 * @param {{ width: number, height: number, fps: number, avcC: Uint8Array,
 *           samples: { data: Uint8Array, key: boolean }[] }} track
 * @returns {Buffer} the complete file
 */
export function writeMp4({ width, height, fps, avcC, samples }) {
  const timescale = fps * 1000;
  const delta = 1000;
  const duration = samples.length * delta;

  const ftyp = box("ftyp", str("isom"), u32(0x200), str("isom"), str("iso2"), str("avc1"), str("mp41"));

  const moovFor = (chunkOffset) => {
    const avc1 = box(
      "avc1",
      zeros(6),
      u16(1), // data_reference_index
      zeros(16), // pre_defined, reserved
      u16(width),
      u16(height),
      u32(0x00480000), // 72 dpi
      u32(0x00480000),
      u32(0),
      u16(1), // frame_count
      zeros(32), // compressorname, left empty
      u16(0x0018), // depth
      u16(0xffff), // pre_defined = -1
      box("avcC", Buffer.from(avcC)),
    );
    const keys = samples.flatMap((s, i) => (s.key ? [i + 1] : []));
    const stbl = box(
      "stbl",
      full("stsd", 0, 0, u32(1), avc1),
      full("stts", 0, 0, u32(1), u32(samples.length), u32(delta)),
      full("stss", 0, 0, u32(keys.length), ...keys.map(u32)),
      full("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1)),
      full("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length))),
      full("stco", 0, 0, u32(1), u32(chunkOffset)),
    );
    const minf = box(
      "minf",
      full("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0)),
      box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1))),
      stbl,
    );
    const mdia = box(
      "mdia",
      full("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0)), // language "und"
      full("hdlr", 0, 0, u32(0), str("vide"), zeros(12), str("VideoHandler\0")),
      minf,
    );
    const tkhd = full(
      "tkhd",
      0,
      3, // enabled, in movie
      u32(0),
      u32(0),
      u32(1), // track_ID
      u32(0),
      u32(duration),
      zeros(8),
      u16(0), // layer
      u16(0), // alternate_group
      u16(0), // volume
      u16(0),
      MATRIX,
      u32(width << 16),
      u32(height << 16),
    );
    const mvhd = full(
      "mvhd",
      0,
      0,
      u32(0),
      u32(0),
      u32(timescale),
      u32(duration),
      u32(0x00010000), // rate 1.0
      u16(0x0100), // volume 1.0
      zeros(10),
      MATRIX,
      zeros(24),
      u32(2), // next_track_ID
    );
    return box("moov", mvhd, box("trak", tkhd, mdia));
  };

  // The chunk offset does not change the moov size, so measure once, then write the real offset.
  const moovSize = moovFor(0).length;
  const moov = moovFor(ftyp.length + moovSize + 8);
  const payload = Buffer.concat(samples.map((s) => Buffer.from(s.data)));
  const mdat = Buffer.concat([u32(8 + payload.length), str("mdat"), payload]);
  return Buffer.concat([ftyp, moov, mdat]);
}
