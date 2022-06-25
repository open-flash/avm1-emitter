mod patchable_buf_writer;
mod primitives;

use crate::patchable_buf_writer::{BufferHole, PatchableBufWriter};
use crate::primitives::{emit_c_string, emit_le32_f64, emit_le_f32, emit_le_i16, emit_le_i32, emit_le_u16, emit_u8};
use avm1_types::cfg::CfgLabel;
use avm1_types::raw;
use avm1_types::raw::FromCfgActionError;
use avm1_types::{cfg, ActionHeader, CatchTarget, GetUrl2Method, PushValue};
use std::collections::HashMap;
use std::convert::{TryFrom, TryInto};
use std::io;
use std::io::Write;

pub fn emit_cfg(value: &cfg::Cfg) -> io::Result<Vec<u8>> {
  let mut avm1_writer = PatchableBufWriter::new();
  write_cfg(&mut avm1_writer, value)?;
  Ok(avm1_writer.complete())
}

fn write_cfg(writer: &mut PatchableBufWriter, value: &cfg::Cfg) -> io::Result<()> {
  write_hard_cfg(writer, value, true)
}

/// Returns `x: i16` such that `source + x == target`, checking for range
fn offset_delta_i16(source: usize, target: usize) -> Option<i16> {
  if target >= source {
    // x = target - source  ∈ [0, 2¹⁵ -1]
    i16::try_from(target - source).ok()
  } else {
    // target < source
    // x ∈ [1, usize::MAX]
    let x: usize = source - target;
    // x = (source - target - 1)  ∈ [0, usize::MAX - 1]
    let x: usize = x - 1;
    // x = (source - target - 1)  ∈ [0, 2¹⁵ - 1]
    // (assuming usize::MAX >= 2¹⁵, true since usize::MAX >= u16::MAX in Rust)
    let x = i16::try_from(x).ok()?;
    // x = -(source - target - 1) = target - source + 1  ∈ [-2¹⁵ + 1, 0]
    // Unchecked wrapping negation is OK because we know the actual range: it will never wrap
    let x = x.wrapping_neg();
    // x = target - source  ∈ [-2¹⁵, -1]
    let x = x - 1;
    Some(x)
  }
}

fn write_hard_cfg(writer: &mut PatchableBufWriter, value: &cfg::Cfg, append_end_action: bool) -> io::Result<()> {
  let wi: WriteInfo = write_soft_cfg(writer, value, None)?;
  let end_offset = writer.len();
  if append_end_action {
    write_raw_action(writer, &raw::Action::End)?;
  }

  for (offset, (hole, target_label)) in wi.jumps.into_iter() {
    let target_offset: usize = match target_label.as_ref() {
      Some(cfg_label) => wi.blocks.get(cfg_label).cloned().expect("TargetLabelNotFound"),
      None => end_offset,
    };
    let offset = offset + 2; // Size of the offset itself inside `If` and `Jump` actions
    let delta = offset_delta_i16(offset, target_offset).expect("TargetOffsetOutOfReach");
    hole.patch(writer, delta);
  }

  Ok(())
}

struct WriteInfo {
  jumps: HashMap<usize, (BufferHole<i16>, Option<cfg::CfgLabel>)>,
  blocks: HashMap<cfg::CfgLabel, usize>,
}

impl WriteInfo {
  pub fn new() -> Self {
    Self {
      jumps: HashMap::new(),
      blocks: HashMap::new(),
    }
  }

  pub fn extend(&mut self, wi: Self) {
    self.jumps.extend(wi.jumps.into_iter());
    self.blocks.extend(wi.blocks.into_iter());
  }
}

fn write_soft_cfg(
  writer: &mut PatchableBufWriter,
  value: &cfg::Cfg,
  fallthrough_next: Option<&cfg::CfgLabel>,
) -> io::Result<WriteInfo> {
  let mut res = WriteInfo::new();

  for (i, block) in value.blocks.iter().enumerate() {
    let cur_next: Option<&cfg::CfgLabel> = match value.blocks.get(i + 1) {
      Some(x) => Some(&x.label),
      None => fallthrough_next,
    };
    let wi: WriteInfo = write_block(writer, block, cur_next)?;
    res.extend(wi);
  }

  Ok(res)
}

fn write_block(
  writer: &mut PatchableBufWriter,
  value: &cfg::CfgBlock,
  fallthrough_next: Option<&cfg::CfgLabel>,
) -> io::Result<WriteInfo> {
  let mut res = WriteInfo::new();

  res.blocks.insert(value.label.clone(), writer.len());

  for action in value.actions.iter().cloned() {
    match raw::Action::try_from(action) {
      Ok(raw) => write_raw_action(writer, &raw)?,
      Err(FromCfgActionError::DefineFunction(action)) => write_define_function(writer, &action)?,
      Err(FromCfgActionError::DefineFunction2(action)) => write_define_function2(writer, &action)?,
    }
  }

  match &value.flow {
    cfg::CfgFlow::Error(_) => write_error(writer)?,
    cfg::CfgFlow::If(ref flow) => {
      let (offset, hole) = write_if(writer)?;
      res.jumps.insert(offset, (hole, flow.true_target.clone()));
      if fallthrough_next != flow.false_target.as_ref() {
        if let Some(false_target) = flow.false_target.as_ref() {
          let (offset, hole) = write_jump(writer)?;
          res.jumps.insert(offset, (hole, Some(false_target.clone())));
        } else {
          write_raw_action(writer, &raw::Action::End)?;
        }
      }
    }
    cfg::CfgFlow::Simple(ref flow) => {
      if fallthrough_next != flow.next.as_ref() {
        if let Some(next) = flow.next.as_ref() {
          let (offset, hole) = write_jump(writer)?;
          res.jumps.insert(offset, (hole, Some(next.clone())));
        } else {
          write_raw_action(writer, &raw::Action::End)?;
        }
      }
    }
    cfg::CfgFlow::Return => write_raw_action(writer, &raw::Action::Return)?,
    cfg::CfgFlow::Throw => write_raw_action(writer, &raw::Action::Throw)?,
    cfg::CfgFlow::Try(ref flow) => {
      write_try(writer, &mut res, flow, fallthrough_next)?;
    }
    cfg::CfgFlow::WaitForFrame(ref flow) => {
      write_raw_action(
        writer,
        &raw::Action::WaitForFrame(raw::WaitForFrame {
          frame: flow.frame,
          skip: 1,
        }),
      )?;
      {
        let (offset, hole) = write_jump(writer)?;
        res.jumps.insert(offset, (hole, flow.ready_target.clone()));
      }
      {
        let (offset, hole) = write_jump(writer)?;
        res.jumps.insert(offset, (hole, flow.loading_target.clone()));
      }
    }
    cfg::CfgFlow::WaitForFrame2(ref flow) => {
      write_raw_action(writer, &raw::Action::WaitForFrame2(raw::WaitForFrame2 { skip: 1 }))?;
      {
        let (offset, hole) = write_jump(writer)?;
        res.jumps.insert(offset, (hole, flow.ready_target.clone()));
      }
      {
        let (offset, hole) = write_jump(writer)?;
        res.jumps.insert(offset, (hole, flow.loading_target.clone()));
      }
    }
    cfg::CfgFlow::With(ref flow) => {
      write_with(writer, &mut res, flow, fallthrough_next)?;
    }
  }

  Ok(res)
}

pub fn emit_raw_action(value: &raw::Action) -> io::Result<Vec<u8>> {
  let mut writer = PatchableBufWriter::new();
  write_raw_action(&mut writer, value)?;
  Ok(writer.complete())
}

fn write_raw_action(writer: &mut PatchableBufWriter, value: &raw::Action) -> io::Result<()> {
  macro_rules! raw {
    ($c: literal) => {{
      emit_u8(writer, $c)?;
      if $c >= 0x80 {
        emit_le_u16(writer, 0)?;
      };
      Ok(())
    }};
    ($c: literal, $f: ident, $a: expr) => {{
      debug_assert!($c >= 0x80);
      emit_u8(writer, $c)?;
      let hole = writer.write_hole_le_u16();
      let body_start = writer.len();
      $f(writer, $a)?;
      let body_end = writer.len();
      let body_len = body_end - body_start;
      hole.patch(writer, body_len.try_into().unwrap());
      Ok(())
    }};
  }

  use raw::Action::*;

  match value {
    Add => raw!(0x0a),
    Add2 => raw!(0x47),
    And => raw!(0x10),
    AsciiToChar => raw!(0x33),
    BitAnd => raw!(0x60),
    BitLShift => raw!(0x63),
    BitOr => raw!(0x61),
    BitRShift => raw!(0x64),
    BitURShift => raw!(0x65),
    BitXor => raw!(0x62),
    Call => raw!(0x9e),
    CallFunction => raw!(0x3d),
    CallMethod => raw!(0x52),
    CastOp => raw!(0x2b),
    CharToAscii => raw!(0x32),
    CloneSprite => raw!(0x24),
    ConstantPool(ref a) => raw!(0x88, write_raw_constant_pool, a),
    Decrement => raw!(0x51),
    DefineFunction(ref a) => raw!(0x9b, write_raw_define_function, a),
    DefineFunction2(ref a) => raw!(0x8e, write_raw_define_function2, a),
    DefineLocal => raw!(0x3c),
    DefineLocal2 => raw!(0x41),
    Delete => raw!(0x3a),
    Delete2 => raw!(0x3b),
    Divide => raw!(0x0d),
    End => raw!(0x00),
    EndDrag => raw!(0x28),
    Enumerate => raw!(0x46),
    Enumerate2 => raw!(0x55),
    Equals => raw!(0x0e),
    Equals2 => raw!(0x49),
    Error(_) => todo!(),
    Extends => raw!(0x69),
    FsCommand2 => raw!(0x2d),
    GetMember => raw!(0x4e),
    GetProperty => raw!(0x22),
    GetTime => raw!(0x34),
    GetUrl(ref a) => raw!(0x83, write_raw_get_url, a),
    GetUrl2(ref a) => raw!(0x9a, write_raw_get_url2, a),
    GetVariable => raw!(0x1c),
    GotoFrame(ref a) => raw!(0x81, write_raw_goto_frame, a),
    GotoFrame2(ref a) => raw!(0x9f, write_raw_goto_frame2, a),
    GotoLabel(ref a) => raw!(0x8c, write_raw_goto_label, a),
    Greater => raw!(0x67),
    If(ref a) => raw!(0x9d, write_raw_if, a),
    ImplementsOp => raw!(0x2c),
    Increment => raw!(0x50),
    InitArray => raw!(0x42),
    InitObject => raw!(0x43),
    InstanceOf => raw!(0x54),
    Jump(ref a) => raw!(0x99, write_raw_jump, a),
    Less => raw!(0x0f),
    Less2 => raw!(0x48),
    MbAsciiToChar => raw!(0x37),
    MbCharToAscii => raw!(0x36),
    MbStringExtract => raw!(0x35),
    MbStringLength => raw!(0x31),
    Modulo => raw!(0x3f),
    Multiply => raw!(0x0c),
    NewMethod => raw!(0x53),
    NewObject => raw!(0x40),
    NextFrame => raw!(0x04),
    Not => raw!(0x12),
    Or => raw!(0x11),
    Play => raw!(0x06),
    Pop => raw!(0x17),
    PrevFrame => raw!(0x05),
    Push(ref a) => raw!(0x96, write_raw_push, a),
    PushDuplicate => raw!(0x4c),
    RandomNumber => raw!(0x30),
    Raw(ref a) => {
      emit_u8(writer, a.code)?;
      if a.code < 0x80 {
        assert!(a.data.is_empty());
      } else {
        let body_len = u16::try_from(a.data.len()).unwrap();
        emit_le_u16(writer, body_len)?;
        writer.write_all(&a.data)?;
      }
      Ok(())
    }
    Return => raw!(0x3e),
    RemoveSprite => raw!(0x25),
    SetMember => raw!(0x4f),
    SetProperty => raw!(0x23),
    SetTarget(ref a) => raw!(0x8b, write_raw_set_target, a),
    SetTarget2 => raw!(0x20),
    SetVariable => raw!(0x1d),
    StackSwap => raw!(0x4d),
    StartDrag => raw!(0x27),
    Stop => raw!(0x07),
    StopSounds => raw!(0x09),
    StoreRegister(ref a) => raw!(0x87, write_raw_store_register, a),
    StrictEquals => raw!(0x66),
    StrictMode(ref a) => raw!(0x89, write_raw_strict_mode, a),
    StringAdd => raw!(0x21),
    StringEquals => raw!(0x13),
    StringExtract => raw!(0x15),
    StringGreater => raw!(0x68),
    StringLength => raw!(0x14),
    StringLess => raw!(0x29),
    Subtract => raw!(0x0b),
    TargetPath => raw!(0x45),
    Throw => raw!(0x2a),
    ToInteger => raw!(0x18),
    ToNumber => raw!(0x4a),
    ToString => raw!(0x4b),
    ToggleQuality => raw!(0x08),
    Trace => raw!(0x26),
    Try(ref a) => raw!(0x8f, write_raw_try, a),
    TypeOf => raw!(0x44),
    WaitForFrame(ref a) => raw!(0x8a, write_raw_wait_for_frame, a),
    WaitForFrame2(ref a) => raw!(0x8d, write_raw_wait_for_frame2, a),
    With(ref a) => raw!(0x94, write_raw_with, a),
  }
}

fn write_raw_constant_pool<W: io::Write>(writer: &mut W, value: &raw::ConstantPool) -> io::Result<()> {
  emit_le_u16(writer, value.pool.len().try_into().unwrap())?;
  for constant in value.pool.iter() {
    emit_c_string(writer, constant)?;
  }
  Ok(())
}

fn write_raw_define_function<W: io::Write>(writer: &mut W, value: &raw::DefineFunction) -> io::Result<()> {
  emit_c_string(writer, &value.name)?;
  emit_le_u16(writer, value.parameters.len().try_into().unwrap())?;
  for parameter in value.parameters.iter() {
    emit_c_string(writer, parameter)?;
  }
  emit_le_u16(writer, value.body_size)
}

fn write_raw_define_function2<W: io::Write>(writer: &mut W, value: &raw::DefineFunction2) -> io::Result<()> {
  emit_c_string(writer, &value.name)?;
  emit_le_u16(writer, value.parameters.len().try_into().unwrap())?;
  emit_u8(writer, value.register_count)?;

  let flags: u16 = value.flags.bits();
  emit_le_u16(writer, flags)?;

  for parameter in value.parameters.iter() {
    emit_u8(writer, parameter.register)?;
    emit_c_string(writer, &parameter.name)?;
  }
  emit_le_u16(writer, value.body_size)
}

fn write_raw_get_url<W: io::Write>(writer: &mut W, value: &raw::GetUrl) -> io::Result<()> {
  emit_c_string(writer, &value.url)?;
  emit_c_string(writer, &value.target)
}

fn write_raw_get_url2<W: io::Write>(writer: &mut W, value: &raw::GetUrl2) -> io::Result<()> {
  let method_code: u8 = match value.method {
    GetUrl2Method::None => 0,
    GetUrl2Method::Get => 1,
    GetUrl2Method::Post => 2,
  };
  #[allow(clippy::identity_op)]
  let flags: u8 = 0
    | (if value.load_variables { 1 << 0 } else { 0 })
    | (if value.load_target { 1 << 1 } else { 0 })
    // Skip bits [2, 5]
    | (method_code << 6);
  emit_u8(writer, flags)
}

fn write_raw_goto_frame<W: io::Write>(writer: &mut W, value: &raw::GotoFrame) -> io::Result<()> {
  emit_le_u16(writer, value.frame)
}

fn write_raw_goto_frame2<W: io::Write>(writer: &mut W, value: &raw::GotoFrame2) -> io::Result<()> {
  let has_scene_bias = value.scene_bias != 0;
  #[allow(clippy::identity_op)]
  let flags: u8 = 0
    // TODO: Find a better way than this comment to prevent rustfmt from changing the layout of this assignment
    | (if value.play { 1 << 0 } else { 0 })
    | (if has_scene_bias { 1 << 1 } else { 0 });
  // Skip bits [2, 7]
  emit_u8(writer, flags)?;
  if has_scene_bias {
    emit_le_u16(writer, value.scene_bias)?;
  }
  Ok(())
}

fn write_raw_goto_label<W: io::Write>(writer: &mut W, value: &raw::GoToLabel) -> io::Result<()> {
  emit_c_string(writer, &value.label)
}

fn write_raw_if<W: io::Write>(writer: &mut W, value: &raw::If) -> io::Result<()> {
  emit_le_i16(writer, value.offset)
}

fn write_raw_jump<W: io::Write>(writer: &mut W, value: &raw::Jump) -> io::Result<()> {
  emit_le_i16(writer, value.offset)
}

fn write_raw_push<W: io::Write>(writer: &mut W, value: &raw::Push) -> io::Result<()> {
  for pushed in value.values.iter() {
    match pushed {
      PushValue::Boolean(v) => {
        emit_u8(writer, 5)?;
        emit_u8(writer, if *v { 1 } else { 0 })?;
      }
      PushValue::Constant(v) => match u8::try_from(*v) {
        Ok(v) => {
          emit_u8(writer, 8)?;
          emit_u8(writer, v)?;
        }
        Err(_) => {
          emit_u8(writer, 9)?;
          emit_le_u16(writer, *v)?;
        }
      },
      PushValue::String(v) => {
        emit_u8(writer, 0)?;
        emit_c_string(writer, v)?;
      }
      PushValue::Sint32(v) => {
        emit_u8(writer, 7)?;
        emit_le_i32(writer, *v)?;
      }
      PushValue::Float32(v) => {
        emit_u8(writer, 1)?;
        emit_le_f32(writer, *v)?;
      }
      PushValue::Float64(v) => {
        emit_u8(writer, 6)?;
        emit_le32_f64(writer, *v)?;
      }
      PushValue::Null => {
        emit_u8(writer, 2)?;
      }
      PushValue::Register(v) => {
        emit_u8(writer, 4)?;
        emit_u8(writer, *v)?;
      }
      PushValue::Undefined => {
        emit_u8(writer, 3)?;
      }
    };
  }
  Ok(())
}

fn write_raw_set_target<W: io::Write>(writer: &mut W, value: &raw::SetTarget) -> io::Result<()> {
  emit_c_string(writer, &value.target_name)
}

fn write_raw_store_register<W: io::Write>(writer: &mut W, value: &raw::StoreRegister) -> io::Result<()> {
  emit_u8(writer, value.register)
}

fn write_raw_strict_mode<W: io::Write>(writer: &mut W, value: &raw::StrictMode) -> io::Result<()> {
  emit_u8(writer, if value.is_strict { 1 } else { 0 })
}

fn write_raw_try<W: io::Write>(writer: &mut W, value: &raw::Try) -> io::Result<()> {
  let catch_in_register: bool = value
    .catch
    .as_ref()
    .map(|c| matches!(c.target, CatchTarget::Register(_)))
    .unwrap_or_default();
  #[allow(clippy::identity_op)]
  let flags: u8 = 0
    | (if value.catch.is_some() { 1 << 0 } else { 0 })
    | (if value.finally.is_some() { 1 << 1 } else { 0 })
    | (if catch_in_register { 1 << 2 } else { 0 });
  // Skip bits [3, 7]
  emit_u8(writer, flags)?;

  emit_le_u16(writer, value.r#try)?;
  emit_le_u16(writer, value.catch.as_ref().map(|c| c.size).unwrap_or(0))?;
  emit_le_u16(writer, value.finally.unwrap_or(0))?;

  if let Some(catch_target) = value.catch.as_ref().map(|c| &c.target) {
    match catch_target {
      CatchTarget::Register(ct) => emit_u8(writer, *ct)?,
      CatchTarget::Variable(ct) => emit_c_string(writer, ct)?,
    };
  }
  Ok(())
}

fn write_raw_wait_for_frame<W: io::Write>(writer: &mut W, value: &raw::WaitForFrame) -> io::Result<()> {
  emit_le_u16(writer, value.frame)?;
  emit_u8(writer, value.skip)
}

fn write_raw_wait_for_frame2<W: io::Write>(writer: &mut W, value: &raw::WaitForFrame2) -> io::Result<()> {
  emit_u8(writer, value.skip)
}

fn write_raw_with<W: io::Write>(writer: &mut W, value: &raw::With) -> io::Result<()> {
  emit_le_u16(writer, value.size)
}

fn write_action_header<W: io::Write>(writer: &mut W, value: ActionHeader) -> io::Result<()> {
  emit_u8(writer, value.code)?;
  if value.length > 0 {
    emit_le_u16(writer, value.length)?
  }
  Ok(())
}

fn write_define_function(writer: &mut PatchableBufWriter, value: &cfg::DefineFunction) -> io::Result<()> {
  let mut body: PatchableBufWriter = PatchableBufWriter::new();
  write_hard_cfg(&mut body, &value.body, false)?;
  write_raw_action(
    writer,
    &raw::Action::DefineFunction(Box::new(raw::DefineFunction {
      name: value.name.clone(),
      parameters: value.parameters.clone(),
      body_size: body.len().try_into().unwrap(),
    })),
  )?;
  writer.write_all(&body.complete())
}

fn write_define_function2(writer: &mut PatchableBufWriter, value: &cfg::DefineFunction2) -> io::Result<()> {
  let mut body: PatchableBufWriter = PatchableBufWriter::new();
  write_hard_cfg(&mut body, &value.body, false)?;
  write_raw_action(
    writer,
    &raw::Action::DefineFunction2(Box::new(raw::DefineFunction2 {
      name: value.name.clone(),
      register_count: value.register_count,
      flags: value.flags,
      parameters: value.parameters.clone(),
      body_size: body.len().try_into().unwrap(),
    })),
  )?;
  writer.write_all(&body.complete())
}

fn write_error<W: io::Write>(writer: &mut W) -> io::Result<()> {
  emit_u8(writer, 0x96)?; // push
  emit_le_u16(writer, 0x0001)?; // data length
  emit_u8(writer, 0xff) // invalid push value type
}

fn write_if(writer: &mut PatchableBufWriter) -> io::Result<(usize, BufferHole<i16>)> {
  write_action_header(writer, ActionHeader { code: 0x9d, length: 2 })?;
  let pos = writer.len();
  let hole = writer.write_hole_le_i16();
  Ok((pos, hole))
}

fn write_jump(writer: &mut PatchableBufWriter) -> io::Result<(usize, BufferHole<i16>)> {
  write_action_header(writer, ActionHeader { code: 0x99, length: 2 })?;
  let pos = writer.len();
  let hole = writer.write_hole_le_i16();
  Ok((pos, hole))
}

fn write_try(
  writer: &mut PatchableBufWriter,
  wi: &mut WriteInfo,
  flow: &cfg::Try,
  fallthrough_next: Option<&CfgLabel>,
) -> io::Result<()> {
  emit_u8(writer, 0x8f)?;
  let action_size_hole = writer.write_hole_le_u16();
  let action_start = writer.len();
  let catch_in_register: bool = flow
    .catch
    .as_ref()
    .map(|c| matches!(c.target, CatchTarget::Register(_)))
    .unwrap_or_default();
  #[allow(clippy::identity_op)]
  let flags: u8 = 0
    | (if flow.catch.is_some() { 1 << 0 } else { 0 })
    | (if flow.finally.is_some() { 1 << 1 } else { 0 })
    | (if catch_in_register { 1 << 2 } else { 0 });
  // Skip bits [3, 7]
  emit_u8(writer, flags)?;

  let try_size_hole = writer.write_hole_le_u16();
  let catch_size_hole = writer.write_hole_le_u16();
  let finally_size_hole = writer.write_hole_le_u16();

  if let Some(catch_target) = flow.catch.as_ref().map(|c| &c.target) {
    match catch_target {
      CatchTarget::Register(ct) => emit_u8(writer, *ct)?,
      CatchTarget::Variable(ct) => emit_c_string(writer, ct)?,
    };
  } else {
    emit_u8(writer, 0)?;
  }
  let action_end = writer.len();
  let action_size = u16::try_from(action_end - action_start).unwrap();
  action_size_hole.patch(writer, action_size);

  let finally_next = fallthrough_next;
  let catch_next = flow.finally.as_ref().map(|x| &x.blocks.first().label).or(finally_next);
  let try_next = flow
    .catch
    .as_ref()
    .map(|x| &x.body.blocks.first().label)
    .or(finally_next);

  let try_wi = write_soft_cfg(writer, &flow.r#try, try_next)?;
  wi.extend(try_wi);
  let try_end = writer.len();
  let try_size = u16::try_from(try_end - action_end).unwrap();
  try_size_hole.patch(writer, try_size);

  if let Some(catch) = flow.catch.as_ref() {
    let catch_wi = write_soft_cfg(writer, &catch.body, catch_next)?;
    wi.extend(catch_wi);
  }
  let catch_end = writer.len();
  let catch_size = u16::try_from(catch_end - try_end).unwrap();
  catch_size_hole.patch(writer, catch_size);

  if let Some(finally) = flow.finally.as_ref() {
    let finally_wi = write_soft_cfg(writer, finally, finally_next)?;
    wi.extend(finally_wi);
  }
  let finally_end = writer.len();
  let finally_size = u16::try_from(finally_end - catch_end).unwrap();
  finally_size_hole.patch(writer, finally_size);

  Ok(())
}

fn write_with(
  writer: &mut PatchableBufWriter,
  wi: &mut WriteInfo,
  flow: &cfg::With,
  fallthrough_next: Option<&CfgLabel>,
) -> io::Result<()> {
  write_action_header(writer, ActionHeader { code: 0x94, length: 2 })?;
  let with_size_hole = writer.write_hole_le_u16();
  let body_start = writer.len();
  let with_wi = write_soft_cfg(writer, &flow.body, fallthrough_next)?;
  let body_end = writer.len();
  with_size_hole.patch(writer, u16::try_from(body_end - body_start).unwrap());
  wi.extend(with_wi);
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use ::test_generator::test_resources;
  use avm1_parser::parse_cfg;
  use avm1_types::cfg::{Cfg, CfgFlow};
  use std::io::Write;
  use std::path::Path;

  #[test_resources("../tests/avm1/[!.]*/*/")]
  fn test_emit_cfg(path: &str) {
    use serde::Serialize;

    let path: &Path = Path::new(path);
    let name_parts: Vec<&str> = path
      .components()
      .rev()
      .take(2)
      .collect::<Vec<_>>()
      .iter()
      .rev()
      .map(|c| c.as_os_str().to_str().unwrap())
      .collect();

    match name_parts.join("/").as_str() {
      "avm1-bytes/misaligned-jump" => return,
      "samples/delta-of-dir" => return,
      "samples/parse-data-string" => return,
      "try/try-empty-catch-overlong-finally-err" => return,
      "try/try-nested-return" => return,
      "wait-for-frame/homestuck-beta2" => return,
      "wait-for-frame/ready-increments" => return,
      "wait-for-frame/ready-jump-increments" => return,
      "wait-for-frame/wff2-ready-increments" => return,
      _ => {}
    }

    let cfg_path = path.join("cfg.json");
    let cfg_bytes: Vec<u8> = ::std::fs::read(cfg_path).expect("Failed to read input CFG");

    let cfg: Cfg = ::serde_json_v8::from_slice(&cfg_bytes).expect("Failed to parse input CFG");

    let actual_avm1 = emit_cfg(&cfg).expect("Failed to convert CFG to AVM1");

    let actual_avm1_path = path.join("local-main.rs.avm1");
    ::std::fs::write(actual_avm1_path, &actual_avm1).expect("Failed to write actual AVM1");

    let actual_cfg = parse_cfg(&actual_avm1);
    let actual_cfg_path = path.join("local-cfg.rs.json");
    let actual_cfg_file = ::std::fs::File::create(actual_cfg_path).expect("Failed to create actual CFG file");
    let actual_cfg_writer = ::std::io::BufWriter::new(actual_cfg_file);

    let mut ser = serde_json_v8::Serializer::pretty(actual_cfg_writer);
    actual_cfg.serialize(&mut ser).expect("Failed to write actual CFG");
    ser.into_inner().write_all(b"\n").unwrap();

    assert!(
      hard_cfg_equivalent(&actual_cfg, &cfg),
      "round-tripped CFG must be equivalent"
    )
  }

  /// Perform a DFS on both control flow graphs at the same time, check if both
  /// traversal go through exactly the same actions.
  fn hard_cfg_equivalent(left: &Cfg, right: &Cfg) -> bool {
    let left_labels = get_hard_cfg_labels(left);
    let right_labels = get_hard_cfg_labels(right);
    let left_id: HashMap<&CfgLabel, usize> = left_labels.into_iter().enumerate().map(|(i, l)| (l, i)).collect();
    let right_id: HashMap<&CfgLabel, usize> = right_labels.into_iter().enumerate().map(|(i, l)| (l, i)).collect();

    let label_eq = |left: Option<&CfgLabel>, right: Option<&CfgLabel>| -> bool {
      match (left, right) {
        (Some(l), Some(r)) => left_id.get(l) == right_id.get(r),
        (l, r) => l == r,
      }
    };

    soft_cfg_equivalent(left, right, &label_eq)
  }

  fn soft_cfg_equivalent(
    left: &Cfg,
    right: &Cfg,
    label_eq: &impl Fn(Option<&CfgLabel>, Option<&CfgLabel>) -> bool,
  ) -> bool {
    let left_blocks = &left.blocks;
    let right_blocks = &right.blocks;
    if left_blocks.len() != right_blocks.len() {
      return false;
    }
    for (left_block, right_block) in left_blocks.iter().zip(right_blocks.iter()) {
      if left_block.actions.len() != right_block.actions.len() {
        return false;
      }
      if !label_eq(Some(&left_block.label), Some(&right_block.label)) {
        return false;
      }
      for (left_action, right_action) in left_block.actions.iter().zip(right_block.actions.iter()) {
        if !action_equivalent(left_action, right_action) {
          return false;
        }
      }
      let flow_eq = match (&left_block.flow, &right_block.flow) {
        (CfgFlow::If(l), CfgFlow::If(r)) => {
          label_eq(l.true_target.as_ref(), r.true_target.as_ref())
            && label_eq(l.false_target.as_ref(), r.false_target.as_ref())
        }
        (CfgFlow::Simple(l), CfgFlow::Simple(r)) => label_eq(l.next.as_ref(), r.next.as_ref()),
        (CfgFlow::Try(l), CfgFlow::Try(r)) => try_equivalent(l, r, label_eq),
        (CfgFlow::WaitForFrame(l), CfgFlow::WaitForFrame(r)) => {
          l.frame == r.frame
            && label_eq(l.ready_target.as_ref(), r.ready_target.as_ref())
            && label_eq(l.loading_target.as_ref(), r.loading_target.as_ref())
        }
        (CfgFlow::WaitForFrame2(l), CfgFlow::WaitForFrame2(r)) => {
          label_eq(l.ready_target.as_ref(), r.ready_target.as_ref())
            && label_eq(l.loading_target.as_ref(), r.loading_target.as_ref())
        }
        (CfgFlow::With(l), CfgFlow::With(r)) => soft_cfg_equivalent(&l.body, &r.body, label_eq),
        (l, r) => l == r,
      };
      if !flow_eq {
        return false;
      }
    }

    true
  }

  fn action_equivalent(left: &cfg::Action, right: &cfg::Action) -> bool {
    match (left, right) {
      (cfg::Action::DefineFunction(l), cfg::Action::DefineFunction(r)) => {
        l.name == r.name && l.parameters == r.parameters && hard_cfg_equivalent(&l.body, &r.body)
      }
      (cfg::Action::DefineFunction2(l), cfg::Action::DefineFunction2(r)) => {
        l.name == r.name
          && l.register_count == r.register_count
          && l.flags == r.flags
          && l.parameters == r.parameters
          && hard_cfg_equivalent(&l.body, &r.body)
      }
      (l, r) => l == r,
    }
  }

  fn try_equivalent(
    left: &cfg::Try,
    right: &cfg::Try,
    label_eq: &impl Fn(Option<&CfgLabel>, Option<&CfgLabel>) -> bool,
  ) -> bool {
    if !soft_cfg_equivalent(&left.r#try, &right.r#try, label_eq) {
      return false;
    }
    let catch_eq = match (left.catch.as_ref(), right.catch.as_ref()) {
      (Some(l), Some(r)) => l.target == r.target && soft_cfg_equivalent(&l.body, &r.body, label_eq),
      (l, r) => l == r,
    };
    if !catch_eq {
      return false;
    }
    match (left.finally.as_ref(), right.finally.as_ref()) {
      (Some(l), Some(r)) => soft_cfg_equivalent(l, r, label_eq),
      (l, r) => l == r,
    }
  }

  fn get_hard_cfg_labels<'a>(hard_cfg: &'a Cfg) -> Vec<&'a CfgLabel> {
    let mut result: Vec<&'a CfgLabel> = Vec::new();

    fn visit<'a>(cfg: &'a Cfg, result: &mut Vec<&'a CfgLabel>) {
      for block in cfg.blocks.iter() {
        result.push(&block.label);
        match &block.flow {
          CfgFlow::Try(ref flow) => {
            visit(&flow.r#try, result);
            if let Some(catch) = &flow.catch {
              visit(&catch.body, result);
            }
            if let Some(finally) = &flow.finally {
              visit(finally, result);
            }
          }
          CfgFlow::With(ref flow) => {
            visit(&flow.body, result);
          }
          _ => {}
        }
      }
    }

    visit(hard_cfg, &mut result);

    result
  }
}
