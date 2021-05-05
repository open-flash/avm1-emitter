use std::io;

pub fn emit_u8<W: io::Write + ?Sized>(writer: &mut W, value: u8) -> io::Result<()> {
  writer.write_all(&[value])
}

pub fn emit_le_u16<W: io::Write + ?Sized>(writer: &mut W, value: u16) -> io::Result<()> {
  writer.write_all(&value.to_le_bytes())
}

pub fn emit_le_i16<W: io::Write + ?Sized>(writer: &mut W, value: i16) -> io::Result<()> {
  writer.write_all(&value.to_le_bytes())
}

pub fn emit_le_i32<W: io::Write + ?Sized>(writer: &mut W, value: i32) -> io::Result<()> {
  writer.write_all(&value.to_le_bytes())
}

pub fn emit_le_f32<W: io::Write + ?Sized>(writer: &mut W, value: f32) -> io::Result<()> {
  use byteorder::WriteBytesExt;
  writer.write_f32::<byteorder::LittleEndian>(value)
}

pub fn emit_le32_f64<W: io::Write + ?Sized>(writer: &mut W, value: f64) -> io::Result<()> {
  let bytes = value.to_le_bytes();
  let bytes = [
    bytes[4], bytes[5], bytes[6], bytes[7], bytes[0], bytes[1], bytes[2], bytes[3],
  ];
  writer.write_all(&bytes)
}

/// Emits a null-terminated string.
pub fn emit_c_string<W: io::Write>(writer: &mut W, value: &str) -> io::Result<()> {
  writer.write_all(value.as_bytes())?;
  writer.write_all(&[0])
}
