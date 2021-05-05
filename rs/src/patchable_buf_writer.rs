use drop_bomb::DropBomb;
use std::io;
use std::io::Write;
use std::mem::size_of;

pub struct PatchableBufWriter {
  buf: Vec<u8>,
  holes: usize,
}

impl Write for PatchableBufWriter {
  fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
    self.buf.write(buf)
  }

  fn flush(&mut self) -> io::Result<()> {
    self.buf.flush()
  }
}

impl PatchableBufWriter {
  pub fn new() -> Self {
    Self {
      buf: Vec::new(),
      holes: 0,
    }
  }

  pub fn len(&self) -> usize {
    self.buf.len()
  }

  pub fn complete(self) -> Vec<u8> {
    assert_eq!(self.holes, 0);
    self.buf
  }

  pub fn write_hole_le_u16(&mut self) -> BufferHole<u16> {
    let hole = BufferHole::new(self.buf.len(), |buf, pos, value: u16| {
      let bytes: [u8; 2] = value.to_le_bytes();
      buf[pos] = bytes[0];
      buf[pos + 1] = bytes[1];
    });
    self.buf.extend_from_slice(&[0; size_of::<u16>()]);
    self.holes += 1;
    hole
  }

  pub fn write_hole_le_i16(&mut self) -> BufferHole<i16> {
    let hole = BufferHole::new(self.buf.len(), |buf, pos, value: i16| {
      let bytes: [u8; 2] = value.to_le_bytes();
      buf[pos] = bytes[0];
      buf[pos + 1] = bytes[1];
    });
    self.buf.extend_from_slice(&[0; size_of::<i16>()]);
    self.holes += 1;
    hole
  }
}

pub struct BufferHole<T: Copy> {
  start: usize,
  patch_fn: fn(&mut [u8], usize, T) -> (),
  bomb: DropBomb,
}

impl<T: Copy> BufferHole<T> {
  fn new(start: usize, patch_fn: fn(&mut [u8], usize, T) -> ()) -> Self {
    Self {
      start,
      patch_fn,
      bomb: DropBomb::new("Hole must be patched before being dropped"),
    }
  }

  pub fn patch(mut self, buf: &mut PatchableBufWriter, value: T) {
    (self.patch_fn)(&mut buf.buf, self.start, value);
    buf.holes -= 1;
    self.bomb.defuse();
  }
}
