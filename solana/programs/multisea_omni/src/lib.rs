//! MultiSea omni drop + escrow on Solana: native program (no Anchor), hand-encoded CPIs to the LayerZero V2 endpoint and
//! Metaplex Core, fixed-layout accounts. Program rent is paid per byte, so the binary is kept small.
//!
//! The Solana side of a MultiSea multichain drop, as a LayerZero V2 OApp (the `Store` PDA is the OApp), speaking the
//! 192-byte message format of the EVM escrows: abi.encode(uint8 kind, bytes32 cid, uint256 a, uint256 b, uint256 c, bytes32 to).
//!
//! New drops (MultiSeaOmniDropV2 + MultiSeaOmniEscrowV2 on EVM):
//! - Base (EVM) is the hub and the only place ids are assigned. A Solana mint is a REQUEST to the hub; the price is held
//!   in the drop until the hub CONFIRMs (ids created Active for the minter) or REJECTs (claimable refund).
//! - Every NFT is a Metaplex Core asset at PDA ["Asset", cid, id] in the drop's Core collection, which carries an
//!   enforced Royalties plugin (program allowlist) whose authority is the Store PDA.
//! - COPY from the hub creates the ids here as locked assets owned by the Store PDA (copies at mint, paid by the minter).
//! - Move out locks the asset in the Store (never burned) and sends MOVE; move in releases the locked asset (or creates
//!   it for the recipient if its COPY has not landed yet).
//! - withdraw() pays fee_bps (0.5%) of the mint proceeds to the MultiSea fee recipient, the rest to the creator payout.
//!
//! Existing V1 collections (MultiSeaOmniDrop + MultiSeaOmniEscrow, whose drops can never list Solana as a chain):
//! - register_existing (admin) creates the collection here; existing_copies (admin) creates every id as a locked copy.
//! - Move in: a per-chain MultiSeaSolanaMover moves the holder's token into the chain's existing V1 escrow, checks the
//!   escrow owns it and sends MOVE. The Store accepts MOVE (only MOVE, only for existing collections) from the mover.
//! - Move out: the usual move_out sends MOVE to the existing V1 escrow (the chain's peer), which releases its copy.

use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    keccak,
    program::{invoke_signed, set_return_data},
    pubkey::Pubkey,
    rent::Rent,
    secp256k1_recover::secp256k1_recover,
    system_program,
    sysvar::Sysvar,
};

/// Errors are raw program error codes (u64): no ProgramError drop glue on every `?`.
type R<T = ()> = Result<T, u64>;

#[cfg(not(feature = "no-entrypoint"))]
mod entry {
    /// # Safety
    /// Called by the runtime with its serialized input.
    #[no_mangle]
    pub unsafe extern "C" fn entrypoint(input: *mut u8) -> u64 {
        let (pid, accounts, data) = solana_program::entrypoint::deserialize(input);
        match crate::process(pid, &accounts, data) {
            Ok(()) => solana_program::entrypoint::SUCCESS,
            Err(e) => e,
        }
    }
    solana_program::custom_heap_default!();
    /// No panic message formatting (size): a panic aborts the transaction.
    #[no_mangle]
    fn custom_panic(_info: &core::panic::PanicInfo<'_>) {}
}

// ---------------------------------------------------------------------- constants
pub const MPL_CORE: Pubkey = Pubkey::new_from_array([175, 84, 171, 16, 189, 151, 165, 66, 160, 158, 247, 179, 152, 137, 221, 12, 211, 148, 164, 204, 233, 223, 166, 205, 201, 126, 190, 45, 35, 91, 167, 72]);
/// Royalties allowlist besides the system program (plain wallets) and this program (the escrow):
/// Magic Eden M2, M3 and Tensor TSWAP, TCMP (royalty-paying marketplaces).
const MARKETS: [[u8; 32]; 4] = [
    [5, 33, 159, 137, 154, 129, 212, 255, 132, 251, 89, 61, 46, 223, 138, 144, 172, 27, 58, 179, 66, 88, 247, 223, 35, 62, 165, 3, 2, 177, 189, 46],
    [5, 34, 193, 12, 179, 36, 234, 165, 1, 129, 244, 48, 203, 203, 80, 221, 198, 10, 131, 244, 246, 140, 241, 90, 190, 112, 228, 14, 227, 128, 26, 194],
    [6, 197, 239, 232, 0, 115, 198, 236, 53, 40, 21, 165, 23, 205, 25, 191, 182, 74, 165, 193, 86, 14, 226, 243, 238, 142, 121, 86, 232, 160, 83, 73],
    [6, 181, 239, 177, 117, 215, 128, 52, 108, 24, 250, 97, 245, 136, 25, 14, 89, 129, 196, 102, 141, 101, 29, 103, 173, 115, 195, 110, 49, 24, 15, 223],
];

pub const MOVE: u8 = 1;
pub const REQUEST: u8 = 2;
pub const CONFIRM: u8 = 3;
pub const REJECT: u8 = 4;
pub const COPY: u8 = 5;
pub const MAX_FEE_BPS: u16 = 1500;
pub const MAX_ROYALTY_BPS: u16 = 1000;
/// Ids per mint / per COPY on Solana (one account per id in the lzReceive transaction). Same cap in MultiSeaOmniDropV2.
pub const SOL_MAX_QTY: u32 = 8;
/// Locked copies per existing_copies transaction (transaction size).
pub const MAX_COPIES_TX: u32 = 20;
pub const MAX_EIDS: usize = 8;
pub const MAX_PHASES: usize = 8;
pub const MAX_NAME: usize = 32;
pub const MAX_URI: usize = 200;
pub const MSG_LEN: usize = 192;

// errors (ProgramError::Custom)
pub const E_PARAMS: u32 = 1;
pub const E_ACCOUNTS: u32 = 2;
pub const E_MESSAGE: u32 = 3;
pub const E_EXPIRED: u32 = 4;
pub const E_SIGNATURE: u32 = 5;
pub const E_UNAUTHORIZED: u32 = 6;
pub const E_PAUSED: u32 = 7;
pub const E_PHASE: u32 = 8;
pub const E_ALLOWLIST: u32 = 9;
pub const E_NOT_PENDING: u32 = 10;
pub const E_NOT_MOVABLE: u32 = 11;
pub const E_SENDER: u32 = 12;

macro_rules! req {
    ($c:expr, $e:expr) => {
        if !($c) {
            return Err($e as u64);
        }
    };
}

// instruction discriminators: first 8 bytes of sha256("global:<name>") (Anchor-compatible; the LayerZero executor calls
// lz_receive_types / lz_receive with these), read as little-endian u64
const I_INIT_STORE: u64 = 0xb513bca35f064afa;
const I_SET_CONFIG: u64 = 0x423462d4af9a9e6c;
const I_TRANSFER_ADMIN: u64 = 0x9c6f0ae46a42f22a;
const I_SET_PEER: u64 = 0xb1e373c8e5b84620;
const I_SET_MOVER: u64 = 0xcc3fd0ab8fb6ca0a;
const I_CREATE_DROP: u64 = 0x303b495cf7918e9d;
const I_MINT: u64 = 0xa68992b62fe13933;
const I_CLAIM_REFUND: u64 = 0x3c61e4ffa11e100f;
const I_MOVE_OUT: u64 = 0x3be9e9dd10fee146;
const I_WITHDRAW: u64 = 0x22a16d949c4612b7;
const I_SET_PAUSED: u64 = 0xdaa6e1b0c07d3c5b;
const I_REVEAL: u64 = 0x734cf9a7be3b2309;
const I_REFRESH_URIS: u64 = 0x9daf003d968ab8be;
const I_LZ_RECEIVE_TYPES: u64 = 0x601f80f89ff611dd;
const I_LZ_RECEIVE: u64 = 0x50bd76216d78b308;
const I_REGISTER_EXISTING: u64 = 0x0564f7096e3d0502;
const I_EXISTING_COPIES: u64 = 0x610ee8f4fb6fc628;
const I_SET_COLLECTION_URI: u64 = 0x94d6b48cbea17073;
// LayerZero endpoint instructions
const EP_REGISTER_OAPP: [u8; 8] = [129, 89, 71, 68, 11, 82, 210, 125];
const EP_SEND: [u8; 8] = [102, 251, 20, 187, 65, 75, 12, 69];
const EP_CLEAR: [u8; 8] = [250, 39, 28, 213, 123, 163, 133, 5];

// ---------------------------------------------------------------------- account layouts (fixed, little-endian)
// Store ["Store"]
const T_STORE: u8 = 1;
const S_BUMP: usize = 1;
const S_FEE_BPS: usize = 2; // u16
const S_EID: usize = 4; // u32
const S_ADMIN: usize = 8;
const S_ENDPOINT: usize = 40;
const S_APPROVER: usize = 72; // 20 bytes
const S_FEE_REC: usize = 92;
const S_MOVE_FEE: usize = 124; // u64
const S_GAS: usize = 132; // request_base, request_per_id, move_gas: u64 x3
pub const S_LEN: usize = 156;
// Peer ["Peer", store, eid be]
const T_PEER: u8 = 2;
const P_EID: usize = 4;
const P_ADDR: usize = 8; // the chain's escrow (sends to it, accepts every kind from it)
const P_MOVER: usize = 40; // existing collections: the chain's MultiSeaSolanaMover (accepts MOVE only)
const P_LEGACY: usize = 72; // existing collections: the chain's existing V1 escrow (move_out sends to it)
pub const P_LEN: usize = 104;
// Drop ["Drop", cid]
const T_DROP: u8 = 3;
const D_BUMP: usize = 1;
const D_FLAGS: usize = 3; // F_*
const D_FEE_BPS: usize = 4;
const D_ROYALTY: usize = 6;
const D_HUB: usize = 8;
const D_MAX: usize = 12;
const D_MINTED: usize = 16;
const D_PENDING: usize = 20;
const D_HELD: usize = 24;
const D_NEXT_RID: usize = 32;
const D_CID: usize = 40;
const D_OWNER: usize = 72;
const D_PAYOUT: usize = 104;
const D_COLLECTION: usize = 136;
const D_FEE_REC: usize = 168;
const D_NEIDS: usize = 200;
const D_NPHASES: usize = 201;
const D_NAME_LEN: usize = 202;
const D_BASE_LEN: usize = 203;
const D_PRE_LEN: usize = 204;
const D_EIDS: usize = 208; // u32 x 8
const D_PHASES: usize = 240; // 64 x 8: start i64, end i64, max_per_wallet u32, max_supply u32, merkle_root [32], price u64
const D_NAME: usize = 752;
const D_BASE: usize = 784;
const D_PRE: usize = 984;
pub const D_LEN: usize = 1184;
const F_PAUSED: u8 = 1;
const F_REVEALED: u8 = 2;
const F_EXISTING: u8 = 4;
// Request ["Req", cid, rid le]
const T_REQ: u8 = 4;
const Q_STATUS: usize = 2;
const Q_QTY: usize = 4;
const Q_START: usize = 8;
const Q_PAID: usize = 16;
const Q_TO: usize = 24;
const Q_PAYER: usize = 56;
pub const Q_LEN: usize = 88;
pub const REQ_PENDING: u8 = 1;
pub const REQ_CONFIRMED: u8 = 2;
pub const REQ_REFUNDED: u8 = 3;

// ---------------------------------------------------------------------- byte helpers
#[inline(never)]
fn g16(d: &[u8], o: usize) -> u16 { let b = &d[o..o + 2]; u16::from_le_bytes([b[0], b[1]]) }
#[inline(never)]
fn g32(d: &[u8], o: usize) -> u32 { let mut b = [0u8; 4]; b.copy_from_slice(&d[o..o + 4]); u32::from_le_bytes(b) }
#[inline(never)]
fn g64(d: &[u8], o: usize) -> u64 { let mut b = [0u8; 8]; b.copy_from_slice(&d[o..o + 8]); u64::from_le_bytes(b) }
#[inline(never)]
fn put(d: &mut [u8], o: usize, b: &[u8]) { d[o..o + b.len()].copy_from_slice(b) }
#[inline(never)]
fn k32(d: &[u8], o: usize) -> [u8; 32] {
    let mut k = [0u8; 32];
    k.copy_from_slice(&d[o..o + 32]);
    k
}
fn pk(d: &[u8], o: usize) -> Pubkey { Pubkey::new_from_array(k32(d, o)) }
#[inline(never)]
fn put32(d: &mut [u8], o: usize, v: u32) { put(d, o, &v.to_le_bytes()) }
#[inline(never)]
fn put64(d: &mut [u8], o: usize, v: u64) { put(d, o, &v.to_le_bytes()) }

/// Borsh reader over instruction data.
struct Rd<'a> { d: &'a [u8], o: usize }
impl<'a> Rd<'a> {
    #[inline(never)]
    fn take(&mut self, n: usize) -> &'a [u8] {
        let s = &self.d[self.o..self.o + n];
        self.o += n;
        s
    }
    fn u8(&mut self) -> u8 { self.take(1)[0] }
    fn u16(&mut self) -> u16 { g16(self.take(2), 0) }
    #[inline(never)]
    fn u32(&mut self) -> u32 { g32(self.take(4), 0) }
    #[inline(never)]
    fn u64(&mut self) -> u64 { g64(self.take(8), 0) }
    #[inline(never)]
    fn k(&mut self) -> [u8; 32] { k32(self.take(32), 0) }
    #[inline(never)]
    fn s(&mut self) -> &'a [u8] { let n = self.u32() as usize; self.take(n) }
}

/// Borsh writer for CPI data.
struct Wr(Vec<u8>);
impl Wr {
    #[inline(never)]
    fn b(&mut self, b: &[u8]) -> &mut Self { self.0.extend_from_slice(b); self }
    fn u32(&mut self, v: u32) -> &mut Self { self.b(&v.to_le_bytes()) }
    fn s(&mut self, b: &[u8]) -> &mut Self { self.u32(b.len() as u32).b(b) }
}

// ---------------------------------------------------------------------- account helpers
/// An account's data without RefCell bookkeeping (size). Never held across a CPI that touches the same account.
#[inline(never)]
fn dat<'a>(a: &'a AccountInfo) -> &'a mut [u8] {
    unsafe { &mut **a.data.as_ptr() }
}
#[inline(never)]
fn signer(a: &AccountInfo) -> R { req!(a.is_signer, E_UNAUTHORIZED); Ok(()) }

/// One of this program's accounts of kind `tag` (only this program writes them; each kind is only ever created at its PDA).
fn ours<'a, const N: usize>(a: &'a AccountInfo, pid: &Pubkey, tag: u8) -> R<&'a mut [u8; N]> {
    req!(a.owner == pid && a.data_len() == N && dat(a)[0] == tag, E_ACCOUNTS);
    Ok(arr::<N>(a))
}
/// Fixed-size view of an account whose length is known to be N (checked, or just allocated by this program):
/// constant offsets then need no bounds checks.
#[inline(always)]
fn arr<'a, const N: usize>(a: &'a AccountInfo) -> &'a mut [u8; N] {
    unsafe { &mut *(dat(a).as_mut_ptr() as *mut [u8; N]) }
}

struct St { bump: u8, fee_bps: u16, eid: u32, admin: Pubkey, endpoint: Pubkey, approver: [u8; 20], fee_rec: Pubkey, move_fee: u64, gas: [u64; 3], key: Pubkey }
#[inline(never)]
fn store(a: &AccountInfo, pid: &Pubkey) -> R<St> {
    let d = ours::<S_LEN>(a, pid, T_STORE)?;
    let mut approver = [0u8; 20];
    approver.copy_from_slice(&d[S_APPROVER..S_APPROVER + 20]);
    Ok(St {
        bump: d[S_BUMP], fee_bps: g16(d, S_FEE_BPS), eid: g32(d, S_EID), admin: pk(d, S_ADMIN), endpoint: pk(d, S_ENDPOINT),
        approver, fee_rec: pk(d, S_FEE_REC), move_fee: g64(d, S_MOVE_FEE),
        gas: [g64(d, S_GAS), g64(d, S_GAS + 8), g64(d, S_GAS + 16)], key: *a.key,
    })
}
#[inline(never)]
fn admin_store(a: &[AccountInfo], pid: &Pubkey) -> R<St> {
    signer(&a[0])?;
    let s = store(&a[1], pid)?;
    req!(*a[0].key == s.admin, E_UNAUTHORIZED);
    Ok(s)
}

/// Peer account for `eid`.
#[inline(never)]
fn peer<'a>(a: &'a AccountInfo, pid: &Pubkey, eid: u32) -> R<&'a mut [u8; P_LEN]> {
    let d = ours::<P_LEN>(a, pid, T_PEER)?;
    req!(g32(d, P_EID) == eid, E_ACCOUNTS);
    Ok(d)
}

#[inline(never)]
fn drop_acc<'a>(a: &'a AccountInfo, pid: &Pubkey) -> R<&'a mut [u8; D_LEN]> { ours::<D_LEN>(a, pid, T_DROP) }

#[inline(never)]
fn has_eid(d: &[u8], e: u32) -> bool { (0..d[D_NEIDS] as usize).any(|i| g32(d, D_EIDS + 4 * i) == e) }

#[inline(never)]
fn find(seeds: &[&[u8]], pid: &Pubkey) -> (Pubkey, u8) { Pubkey::find_program_address(seeds, pid) }
#[inline(never)]
fn asset_pda(cid: &[u8], id: u32, pid: &Pubkey) -> (Pubkey, u8) { find(&[b"Asset", cid, &id.to_le_bytes()], pid) }

/// Rent-exempt minimum without floating point: (len + 128) * lamports_per_byte_year * exemption_threshold, where the
/// threshold (an f64 in the Rent sysvar, 2.0 on every cluster) must be a whole number.
fn rent_min(len: usize) -> R<u64> {
    let r = Rent::get()?;
    let bits = r.exemption_threshold.to_bits();
    let e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let m = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
    req!((0..=10).contains(&e) && m & ((1u64 << (52 - e)) - 1) == 0, E_PARAMS);
    Ok((len as u64 + 128) * r.lamports_per_byte_year * (m >> (52 - e)))
}

/// System program instruction (bincode: u32 tag + fields), built by hand.
fn sys_ix(all: &[AccountInfo], tag: u32, from: &AccountInfo, to: &AccountInfo, two: bool, args: &[&[u8]], seeds: &[&[u8]]) -> R {
    let mut w = Wr(Vec::with_capacity(52));
    w.u32(tag);
    for x in args { w.b(x); }
    let mut accounts = vec![AccountMeta::new(*from.key, true)];
    if two { accounts.push(AccountMeta::new(*to.key, !seeds.is_empty() && tag == 0)); }
    let ix = Instruction { program_id: system_program::ID, accounts, data: w.0 };
    Ok(if seeds.is_empty() { invoke_signed(&ix, all, &[]) } else { invoke_signed(&ix, all, &[seeds]) }?)
}
fn transfer(all: &[AccountInfo], from: &AccountInfo, to: &AccountInfo, v: u64) -> R {
    sys_ix(all, 2, from, to, true, &[&v.to_le_bytes()], &[])
}

/// Create a program-owned PDA (also works if someone pre-funded the address).
fn create_pda(all: &[AccountInfo], payer: &AccountInfo, acc: &AccountInfo, len: usize, seeds: &[&[u8]], pid: &Pubkey) -> R {
    let need = rent_min(len)?;
    let have = acc.lamports();
    let space = (len as u64).to_le_bytes();
    if have == 0 {
        return sys_ix(all, 0, payer, acc, true, &[&need.to_le_bytes(), &space, pid.as_ref()], seeds);
    }
    if need > have { transfer(all, payer, acc, need - have)?; }
    sys_ix(all, 8, acc, acc, false, &[&space], seeds)?;
    sys_ix(all, 1, acc, acc, false, &[pid.as_ref()], seeds)
}

#[inline(never)]
fn move_lamports(from: &AccountInfo, to: &AccountInfo, v: u64) -> R {
    let f = from.lamports().checked_sub(v).ok_or(E_PARAMS as u64)?;
    let t = to.lamports().checked_add(v).ok_or(E_PARAMS as u64)?;
    **from.lamports.borrow_mut() = f;
    **to.lamports.borrow_mut() = t;
    Ok(())
}

fn meta(a: &AccountInfo, signer: bool) -> AccountMeta {
    AccountMeta { pubkey: *a.key, is_signer: signer || a.is_signer, is_writable: a.is_writable }
}

// ---------------------------------------------------------------------- dispatch
pub fn process(pid: &Pubkey, a: &[AccountInfo], data: &[u8]) -> R {
    req!(data.len() >= 8 && !a.is_empty(), E_PARAMS);
    let mut r = Rd { d: data, o: 8 };
    let ix = g64(data, 0);
    // lz_receive_types is the only instruction with a single account (the store)
    if ix == I_LZ_RECEIVE_TYPES { return lz_receive_types(pid, a, &mut r); }
    req!(a.len() >= 2, E_ACCOUNTS);
    match ix {
        I_INIT_STORE => init_store(pid, a, &mut r),
        I_SET_CONFIG => { admin_store(a, pid)?; write_config(&a[1], &mut r) }
        I_TRANSFER_ADMIN => { admin_store(a, pid)?; let k = r.k(); put(dat(&a[1]), S_ADMIN, &k); Ok(()) }
        I_SET_PEER => set_peer(pid, a, &mut r),
        I_SET_MOVER => {
            admin_store(a, pid)?;
            // eid u32, mover [32], existing V1 escrow [32]
            let eid = r.u32();
            put(peer(&a[2], pid, eid)?, P_MOVER, r.take(64));
            Ok(())
        }
        I_CREATE_DROP => create_drop(pid, a, data, &mut r),
        I_REGISTER_EXISTING => register_existing(pid, a, &mut r),
        I_EXISTING_COPIES => existing_copies(pid, a, &mut r),
        I_MINT => mint(pid, a, &mut r),
        I_CLAIM_REFUND => claim_refund(pid, a, &mut r),
        I_MOVE_OUT => move_out(pid, a, &mut r),
        I_WITHDRAW => withdraw(pid, a),
        I_SET_PAUSED | I_REVEAL => {
            signer(&a[0])?;
            let d = drop_acc(&a[1], pid)?;
            req!(*a[0].key == pk(d, D_OWNER), E_UNAUTHORIZED);
            if g64(data, 0) == I_SET_PAUSED {
                let p = r.u8() != 0;
                d[D_FLAGS] = if p { d[D_FLAGS] | F_PAUSED } else { d[D_FLAGS] & !F_PAUSED };
            } else {
                let b = r.s();
                req!(b.len() <= MAX_URI, E_PARAMS);
                put(d, D_BASE, b);
                d[D_BASE_LEN] = b.len() as u8;
                d[D_FLAGS] |= F_REVEALED;
            }
            Ok(())
        }
        I_REFRESH_URIS => refresh_uris(pid, a, &mut r),
        I_SET_COLLECTION_URI => set_collection_uri(pid, a, &mut r),
        I_LZ_RECEIVE => lz_receive(pid, a, &mut r),
        _ => Err(E_PARAMS as u64),
    }
}

// ---------------------------------------------------------------------- admin
/// One-time. `admin` (MC's wallet) becomes the admin and the LayerZero delegate.
/// Accounts: payer, store, lz_receive_types, system, then the endpoint register_oapp accounts (endpoint program first).
fn init_store(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 7, E_ACCOUNTS);
    signer(&a[0])?;
    let (skey, bump) = find(&[b"Store"], pid);
    req!(*a[1].key == skey, E_ACCOUNTS);
    let admin = r.k();
    let endpoint = Pubkey::new_from_array(r.k());
    let eid = r.u32();
    create_pda(a, &a[0], &a[1], S_LEN, &[b"Store", &[bump]], pid)?;
    {
        let d = arr::<S_LEN>(&a[1]);
        d[0] = T_STORE;
        d[S_BUMP] = bump;
        put32(d, S_EID, eid);
        put(d, S_ADMIN, &admin);
        put(d, S_ENDPOINT, endpoint.as_ref());
    }
    write_config(&a[1], r)?;
    // the LayerZero executor reads the accounts lz_receive_types needs from this PDA: 8 bytes + [store]
    let (tkey, tbump) = find(&[b"LzReceiveTypes", skey.as_ref()], pid);
    req!(*a[2].key == tkey, E_ACCOUNTS);
    create_pda(a, &a[0], &a[2], 40, &[b"LzReceiveTypes", skey.as_ref(), &[tbump]], pid)?;
    put(dat(&a[2]), 8, skey.as_ref());
    // register_oapp(delegate = admin): payer, oapp (signer), oapp_registry, system, event_authority, program
    let ep = &a[4..];
    req!(*ep[0].key == endpoint && *ep[2].key == skey, E_ACCOUNTS);
    let mut w = Wr(Vec::with_capacity(40));
    w.b(&EP_REGISTER_OAPP).b(&admin);
    endpoint_cpi(&endpoint, &skey, bump, ep, w.0)
}

/// approver [20], fee_recipient, fee_bps u16, move_fee u64, gas (u64 x3)
#[inline(never)]
fn write_config(st: &AccountInfo, r: &mut Rd) -> R {
    let approver = r.take(20);
    let fee_rec = r.k();
    let fee_bps = r.u16();
    req!(fee_bps <= MAX_FEE_BPS, E_PARAMS);
    let rest = r.take(32); // move_fee + gas
    let d = arr::<S_LEN>(st);
    put(d, S_APPROVER, approver);
    put(d, S_FEE_REC, &fee_rec);
    put(d, S_FEE_BPS, &fee_bps.to_le_bytes());
    put(d, S_MOVE_FEE, rest);
    Ok(())
}

/// admin, store, peer, system. eid u32, address [32]. Creates the peer if needed.
fn set_peer(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 4, E_ACCOUNTS);
    let s = admin_store(a, pid)?;
    let (eid, addr) = (r.u32(), r.k());
    if a[2].data_is_empty() {
        let be = eid.to_be_bytes();
        let (k, b) = find(&[b"Peer", s.key.as_ref(), &be], pid);
        req!(*a[2].key == k, E_ACCOUNTS);
        create_pda(a, &a[0], &a[2], P_LEN, &[b"Peer", s.key.as_ref(), &be, &[b]], pid)?;
        let d = arr::<P_LEN>(&a[2]);
        d[0] = T_PEER;
        d[1] = b;
        put32(d, P_EID, eid);
    }
    put(peer(&a[2], pid, eid)?, P_ADDR, &addr);
    Ok(())
}

// ---------------------------------------------------------------------- drops
struct DropIn<'a> {
    name: &'a [u8], collection_uri: &'a [u8], base_uri: &'a [u8], pre_uri: &'a [u8], payout: [u8; 32],
    royalty: u16, max_supply: u32, hub: u32, eids: &'a [u8], phases: &'a [u8], owner: Pubkey, flags: u8,
}

fn read_eids<'a>(r: &mut Rd<'a>, local: u32) -> R<&'a [u8]> {
    let n = r.u32() as usize;
    req!((2..=MAX_EIDS).contains(&n), E_PARAMS);
    let e = r.take(4 * n);
    let mut local_in = false;
    for i in 0..n {
        let x = g32(e, 4 * i);
        local_in |= x == local;
        for j in 0..i { req!(g32(e, 4 * j) != x, E_PARAMS); }
    }
    req!(local_in, E_PARAMS);
    Ok(e)
}

/// Writes the drop account + creates its Core collection (enforced royalties, update + plugin authority = Store PDA).
/// Accounts: payer (signer), store, drop, collection, core, system.
#[inline(never)]
fn new_drop(pid: &Pubkey, a: &[AccountInfo], s: &St, cid: &[u8; 32], p: &DropIn) -> R {
    req!(p.max_supply > 0 && p.royalty <= MAX_ROYALTY_BPS, E_PARAMS);
    req!(p.name.len() <= MAX_NAME && p.collection_uri.len() <= MAX_URI && p.base_uri.len() <= MAX_URI && p.pre_uri.len() <= MAX_URI, E_PARAMS);
    let (dkey, dbump) = find(&[b"Drop", cid], pid);
    let (ckey, cbump) = find(&[b"Collection", cid], pid);
    req!(*a[2].key == dkey && *a[3].key == ckey, E_ACCOUNTS);
    create_pda(a, &a[0], &a[2], D_LEN, &[b"Drop", cid, &[dbump]], pid)?;
    {
        let d = arr::<D_LEN>(&a[2]);
        d[0] = T_DROP;
        d[D_BUMP] = dbump;
        d[2] = cbump;
        d[D_FLAGS] = p.flags | if p.pre_uri.is_empty() { F_REVEALED } else { 0 };
        put(d, D_FEE_BPS, &s.fee_bps.to_le_bytes());
        put(d, D_ROYALTY, &p.royalty.to_le_bytes());
        put32(d, D_HUB, p.hub);
        put32(d, D_MAX, p.max_supply);
        put(d, D_CID, cid);
        put(d, D_OWNER, p.owner.as_ref());
        put(d, D_PAYOUT, &p.payout);
        put(d, D_COLLECTION, ckey.as_ref());
        put(d, D_FEE_REC, s.fee_rec.as_ref());
        d[D_NEIDS] = (p.eids.len() / 4) as u8;
        d[D_NPHASES] = (p.phases.len() / 64) as u8;
        d[D_NAME_LEN] = p.name.len() as u8;
        d[D_BASE_LEN] = p.base_uri.len() as u8;
        d[D_PRE_LEN] = p.pre_uri.len() as u8;
        put(d, D_EIDS, p.eids);
        put(d, D_PHASES, p.phases);
        put(d, D_NAME, p.name);
        put(d, D_BASE, p.base_uri);
        put(d, D_PRE, p.pre_uri);
    }
    // Metaplex Core CreateCollectionV2 (21): collection (w, s), update_authority, payer (w, s), system
    let mut w = Wr(Vec::with_capacity(512));
    w.b(&[21]).s(p.name).s(p.collection_uri);
    // plugins: Some([ { Royalties { bps, creators: [{payout, 100}], ProgramAllowList([system, this, markets..]) }, Some(UpdateAuthority) } ])
    w.b(&[1]).u32(1).b(&[0]).b(&p.royalty.to_le_bytes()).u32(1).b(&p.payout).b(&[100, 1]).u32(6).b(&[0u8; 32]).b(pid.as_ref());
    for m in MARKETS.iter() { w.b(m); }
    w.b(&[1, 2, 0]); // authority Some(UpdateAuthority); external plugin adapters None
    let ix = Instruction {
        program_id: MPL_CORE,
        accounts: vec![AccountMeta::new(ckey, true), AccountMeta::new_readonly(s.key, false), AccountMeta::new(*a[0].key, true), AccountMeta::new_readonly(system_program::ID, false)],
        data: w.0,
    };
    Ok(invoke_signed(&ix, a, &[&[b"Store", &[s.bump]], &[b"Collection", cid, &[cbump]]])?)
}

/// The creator creates the drop's Solana side (creator pays rent). MultiSea's approver (the key the EVM factories trust)
/// signs, as an EIP-191 personal message, keccak("MultiSeaSolanaDrop" | programId | creator | keccak(borsh(params)) | cid | deadline).
/// Data: cid [32], DropParams (borsh), deadline i64, sig [64], recovery id u8.
fn create_drop(pid: &Pubkey, a: &[AccountInfo], data: &[u8], r: &mut Rd) -> R {
    req!(a.len() >= 6, E_ACCOUNTS);
    signer(&a[0])?;
    let s = store(&a[1], pid)?;
    let cid = r.k();
    let p0 = r.o;
    let name = r.s();
    let collection_uri = r.s();
    let base_uri = r.s();
    let pre_uri = r.s();
    let payout = r.k();
    let royalty = r.u16();
    let max_supply = r.u32();
    let hub = r.u32();
    let eids = read_eids(r, s.eid)?;
    let np = r.u32() as usize;
    req!(np >= 1 && np <= MAX_PHASES, E_PARAMS);
    let phases = r.take(64 * np);
    let params = &data[p0..r.o];
    let deadline = r.u64() as i64;
    let sig = r.take(64);
    let rec = r.u8();
    req!(Clock::get()?.unix_timestamp <= deadline, E_EXPIRED);
    let inner = keccak::hashv(&[b"MultiSeaSolanaDrop", pid.as_ref(), a[0].key.as_ref(), &keccak::hash(params).0, &cid, &deadline.to_le_bytes()]).0;
    let digest = keccak::hashv(&[b"\x19Ethereum Signed Message:\n32", &inner]).0;
    let pubk = secp256k1_recover(&digest, rec, sig).map_err(|_| E_SIGNATURE as u64)?;
    req!(keccak::hash(&pubk.0).0[12..] == s.approver, E_SIGNATURE);
    req!(hub != s.eid && (0..eids.len() / 4).any(|i| g32(eids, 4 * i) == hub), E_PARAMS);
    for i in 0..np {
        let (st, en, ms) = (g64(phases, 64 * i) as i64, g64(phases, 64 * i + 8) as i64, g32(phases, 64 * i + 20));
        req!((en == 0 || en > st) && ms <= max_supply, E_PARAMS);
    }
    new_drop(pid, a, &s, &cid, &DropIn { name, collection_uri, base_uri, pre_uri, payout, royalty, max_supply, hub, eids, phases, owner: *a[0].key, flags: 0 })
}

/// Admin: give an existing (V1, EVM-only) MultiSea collection a Solana side with the same collection id. No mint here
/// (V1 hubs can't assign to Solana): every id becomes a locked copy (existing_copies) and moves in/out through the
/// chain's existing V1 escrow. Royalties are copied once from the EVM collection (bps + the creator's Solana payout).
/// Accounts: admin, store, drop, collection, core, system. Data: cid, name, collection_uri, base_uri, payout, royalty_bps u16,
/// max_supply u32, eids Vec<u32> (the V1 drop's chains + Solana).
fn register_existing(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 6, E_ACCOUNTS);
    let s = admin_store(a, pid)?;
    let cid = r.k();
    let name = r.s();
    let collection_uri = r.s();
    let base_uri = r.s();
    let payout = r.k();
    let royalty = r.u16();
    let max_supply = r.u32();
    let eids = read_eids(r, s.eid)?;
    new_drop(pid, a, &s, &cid, &DropIn { name, collection_uri, base_uri, pre_uri: &[], payout, royalty, max_supply, hub: 0, eids, phases: &[], owner: s.admin, flags: F_EXISTING })
}

/// Admin: create ids [start, start+qty) of an existing collection as locked copies (owned by the Store), skipping ids
/// that exist already. Accounts: admin, store, drop, collection, core, system, assets[qty]. Data: start u32, qty u32.
fn existing_copies(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 6, E_ACCOUNTS);
    let s = admin_store(a, pid)?;
    let d = drop_acc(&a[2], pid)?;
    let (start, qty) = (r.u32(), r.u32());
    req!(d[D_FLAGS] & F_EXISTING != 0 && *a[3].key == pk(d, D_COLLECTION), E_ACCOUNTS);
    req!(start >= 1 && qty >= 1 && qty <= MAX_COPIES_TX && (start + qty - 1) <= g32(d, D_MAX) && a.len() == 6 + qty as usize, E_PARAMS);
    let c = Core { all: a, collection: &a[3], payer: &a[0], store: &a[1], bump: s.bump };
    for k in 0..qty {
        let asset = &a[6 + k as usize];
        if asset.data_is_empty() { c.create(pid, d, start + k, asset, &a[1])?; }
    }
    Ok(())
}

/// Mint on Solana: a REQUEST to the hub. The price is held in the drop until the hub answers. `hub_value` (wei) is dropped
/// on the hub to pay its fan-out. Accounts: minter, store, drop, peer (hub), request, system, then endpoint send accounts.
/// Data: phase u8, qty u32, proof Vec<[32]>, hub_value u128, native_fee u64.
fn mint(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 6, E_ACCOUNTS);
    signer(&a[0])?;
    let s = store(&a[1], pid)?;
    let d = drop_acc(&a[2], pid)?;
    let phase = r.u8() as usize;
    let qty = r.u32();
    let np = r.u32() as usize;
    let proof = r.take(32 * np);
    let hub_value = r.take(16);
    let native_fee = r.u64();
    let to = *a[0].key;
    let (cid, rid, hub, cost) = {
        req!(d[D_FLAGS] & F_PAUSED == 0, E_PAUSED);
        req!(qty > 0 && qty <= SOL_MAX_QTY && phase < d[D_NPHASES] as usize, E_PARAMS);
        let ph = &d[D_PHASES + 64 * phase..D_PHASES + 64 * phase + 64];
        let now = Clock::get()?.unix_timestamp;
        let (st, en) = (g64(ph, 0) as i64, g64(ph, 8) as i64);
        req!(now >= st && (en == 0 || now < en), E_PHASE);
        let root = &ph[24..56];
        if root != [0u8; 32] {
            // same leaf as EVM: keccak(keccak(abi.encode(bytes32 to)))
            let mut node = keccak::hash(&keccak::hash(to.as_ref()).0).0;
            for i in 0..np {
                let p = &proof[32 * i..32 * i + 32];
                node = if node[..] <= *p { keccak::hashv(&[&node, p]).0 } else { keccak::hashv(&[p, &node]).0 };
            }
            req!(node[..] == *root, E_ALLOWLIST);
        }
        let cost = g64(ph, 56).checked_mul(qty as u64).ok_or(E_PARAMS as u64)?;
        (k32(d, D_CID), g64(d, D_NEXT_RID) + 1, g32(d, D_HUB), cost)
    };
    let hub_addr = k32(peer(&a[3], pid, hub)?, P_ADDR);
    if cost > 0 { transfer(a, &a[0], &a[2], cost)?; }
    {
        put64(d, D_NEXT_RID, rid);
        let held = g64(d, D_HELD) + cost;
        put64(d, D_HELD, held);
        let pend = g32(d, D_PENDING) + qty;
        put32(d, D_PENDING, pend);
    }
    let ridb = rid.to_le_bytes();
    let (qkey, qb) = find(&[b"Req", &cid, &ridb], pid);
    req!(*a[4].key == qkey, E_PARAMS);
    create_pda(a, &a[0], &a[4], Q_LEN, &[b"Req", &cid, &ridb, &[qb]], pid)?;
    {
        let q = arr::<Q_LEN>(&a[4]);
        q[0] = T_REQ;
        q[1] = qb;
        q[Q_STATUS] = REQ_PENDING;
        put32(q, Q_QTY, qty);
        put64(q, Q_PAID, cost);
        put(q, Q_TO, to.as_ref());
        put(q, Q_PAYER, to.as_ref());
    }
    let msg = encode_msg(REQUEST, &cid, rid, qty as u64, phase as u64, to.as_ref());
    let mut hv = [0u8; 16];
    hv.copy_from_slice(hub_value);
    let opts = lz_option(s.gas[0] + s.gas[1] * qty as u64, u128::from_le_bytes(hv));
    send_lz(&s, hub, &hub_addr, &msg, &opts, native_fee, &a[6..])
}

/// After a REJECT from the hub the minter reclaims the held price (closes the request).
/// Accounts: payer (request payer), drop, request. Data: rid u64.
fn claim_refund(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 3, E_ACCOUNTS);
    let d = drop_acc(&a[1], pid)?;
    let q = ours::<Q_LEN>(&a[2], pid, T_REQ)?;
    let rid = r.u64();
    let paid = {
        let key = Pubkey::create_program_address(&[b"Req", &d[D_CID..D_CID + 32], &rid.to_le_bytes(), &[q[1]]], pid).map_err(|_| E_ACCOUNTS as u64)?;
        req!(*a[2].key == key && *a[0].key == pk(q, Q_PAYER), E_ACCOUNTS);
        req!(q[Q_STATUS] == REQ_REFUNDED, E_NOT_PENDING);
        g64(q, Q_PAID)
    };
    {
        let held = g64(d, D_HELD) - paid;
        put64(d, D_HELD, held);
    }
    move_lamports(&a[1], &a[0], paid)?;
    close(&a[2], &a[0])
}

#[inline(never)]
fn close(acc: &AccountInfo, to: &AccountInfo) -> R {
    move_lamports(acc, to, acc.lamports())?;
    acc.realloc(0, false)?;
    acc.assign(&system_program::ID);
    Ok(())
}

/// Lock `token_id` here (the Store PDA becomes the holder; never burned) and make it Active for `to` on `dst_eid`.
/// Pays the MultiSea move fee to the fee recipient + the LayerZero fee.
/// Accounts: holder, store, drop, peer (dst), asset, collection, fee_recipient, core, system, then endpoint send accounts.
/// Data: token_id u32, dst_eid u32, to [32], native_fee u64.
fn move_out(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 9, E_ACCOUNTS);
    signer(&a[0])?;
    let s = store(&a[1], pid)?;
    let d = drop_acc(&a[2], pid)?;
    let (id, dst, to, native_fee) = (r.u32(), r.u32(), r.k(), r.u64());
    let cid = {
        // every other chain is EVM: the recipient must be a 20-byte address (V1 escrows decode `address to`)
        req!(dst != s.eid && has_eid(d, dst) && to != [0u8; 32] && to[..12] == [0u8; 12], E_PARAMS);
        req!(*a[5].key == pk(d, D_COLLECTION) && *a[6].key == s.fee_rec, E_ACCOUNTS);
        k32(d, D_CID)
    };
    req!(*a[4].key == asset_pda(&cid, id, pid).0, E_PARAMS);
    req!(asset_owner(&a[4])? == *a[0].key, E_NOT_MOVABLE);
    // existing collections go back through the chain's existing V1 escrow
    let pd = peer(&a[3], pid, dst)?;
    let dst_addr = k32(pd, if d[D_FLAGS] & F_EXISTING != 0 { P_LEGACY } else { P_ADDR });
    req!(dst_addr != [0u8; 32], E_ACCOUNTS);
    core_transfer(a, &a[4], &a[5], &a[0], &a[0], &a[1], None)?;
    if s.move_fee > 0 { transfer(a, &a[0], &a[6], s.move_fee)?; }
    let msg = encode_msg(MOVE, &cid, id as u64, 0, 0, &to);
    let opts = lz_option(s.gas[2], 0);
    send_lz(&s, dst, &dst_addr, &msg, &opts, native_fee, &a[9..])
}

/// Pays out the drop's Solana mint proceeds: fee_bps to the fee recipient snapshotted at creation, the rest to the payout.
/// Held payments (pending requests, unclaimed refunds) and the account's rent are never withdrawable.
/// Accounts: drop, fee_recipient, payout.
fn withdraw(pid: &Pubkey, a: &[AccountInfo]) -> R {
    req!(a.len() >= 3, E_ACCOUNTS);
    let d = drop_acc(&a[0], pid)?;
    let (bal, fee) = {
        req!(*a[1].key == pk(d, D_FEE_REC) && *a[2].key == pk(d, D_PAYOUT), E_ACCOUNTS);
        let bal = a[0].lamports().saturating_sub(rent_min(D_LEN)?).saturating_sub(g64(d, D_HELD));
        let bps = g16(d, D_FEE_BPS) as u64;
        (bal, bal / 10_000 * bps + bal % 10_000 * bps / 10_000)
    };
    if fee > 0 { move_lamports(&a[0], &a[1], fee)?; }
    if bal > fee { move_lamports(&a[0], &a[2], bal - fee)?; }
    Ok(())
}

/// After a reveal: point created assets at base_uri<id>.json. Permissionless (it only applies the drop's URI).
/// Accounts: payer, store, drop, collection, core, system, assets (same order as ids). Data: ids Vec<u32>.
fn refresh_uris(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 6, E_ACCOUNTS);
    signer(&a[0])?;
    let s = store(&a[1], pid)?;
    let d = drop_acc(&a[2], pid)?;
    let n = r.u32() as usize;
    let ids = r.take(4 * n);
    req!(d[D_FLAGS] & F_REVEALED != 0 && a.len() == 6 + n && *a[3].key == pk(d, D_COLLECTION), E_PARAMS);
    let mut uri = [0u8; MAX_URI + 16];
    for i in 0..n {
        let id = g32(ids, 4 * i);
        let asset = &a[6 + i];
        req!(*asset.key == asset_pda(&d[D_CID..D_CID + 32], id, pid).0, E_PARAMS);
        let ul = uri_of(d, id, &mut uri);
        // UpdateV1 (15): asset (w), collection, payer (w, s), authority (s), system, log wrapper. new_name None, new_uri Some, new_update_authority None
        let mut w = Wr(Vec::with_capacity(ul + 8));
        w.b(&[15, 0, 1]).s(&uri[..ul]).b(&[0]);
        let ix = Instruction {
            program_id: MPL_CORE,
            accounts: vec![AccountMeta::new(*asset.key, false), AccountMeta::new_readonly(*a[3].key, false), AccountMeta::new(*a[0].key, true),
                AccountMeta::new_readonly(s.key, true), AccountMeta::new_readonly(system_program::ID, false), AccountMeta::new_readonly(MPL_CORE, false)],
            data: w.0,
        };
        invoke_signed(&ix, a, &[&[b"Store", &[s.bump]]])?;
    }
    Ok(())
}

/// Drop owner: set the drop's Core collection name (empty = keep) and URI (marketplaces read the collection image from it).
/// Accounts: owner (s, w: pays any Core realloc), store, drop, collection (w), core, system. Data: name String, uri String.
fn set_collection_uri(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 6, E_ACCOUNTS);
    signer(&a[0])?;
    let s = store(&a[1], pid)?;
    let d = drop_acc(&a[2], pid)?;
    req!(*a[0].key == pk(d, D_OWNER), E_UNAUTHORIZED);
    req!(*a[3].key == pk(d, D_COLLECTION) && *a[4].key == MPL_CORE, E_ACCOUNTS);
    let name = r.s();
    let uri = r.s();
    req!(name.len() <= MAX_NAME && !uri.is_empty() && uri.len() <= MAX_URI, E_PARAMS);
    // UpdateCollectionV1 (16): collection (w), payer (w, s), authority (s), new_update_authority (None), system, log wrapper (None)
    let mut w = Wr(Vec::new());
    w.b(&[16]);
    if name.is_empty() { w.b(&[0]); } else { w.b(&[1]).s(name); }
    w.b(&[1]).s(uri);
    let ix = Instruction {
        program_id: MPL_CORE,
        accounts: vec![AccountMeta::new(*a[3].key, false), AccountMeta::new(*a[0].key, true), AccountMeta::new_readonly(s.key, true),
            AccountMeta::new_readonly(MPL_CORE, false), AccountMeta::new_readonly(system_program::ID, false), AccountMeta::new_readonly(MPL_CORE, false)],
        data: w.0,
    };
    invoke_signed(&ix, a, &[&[b"Store", &[s.bump]]])?;
    Ok(())
}

// ---------------------------------------------------------------------- Metaplex Core
struct Core<'a, 'b> { all: &'a [AccountInfo<'b>], collection: &'a AccountInfo<'b>, payer: &'a AccountInfo<'b>, store: &'a AccountInfo<'b>, bump: u8 }
impl<'a, 'b> Core<'a, 'b> {
    /// CreateV2 (20) asset `id` at its PDA in the drop's collection, owned by `owner`; `payer` pays the rent.
    fn create(&self, pid: &Pubkey, d: &[u8], id: u32, asset: &AccountInfo<'b>, owner: &AccountInfo<'b>) -> R {
        let (key, bump) = asset_pda(&d[D_CID..D_CID + 32], id, pid);
        req!(*asset.key == key, E_ACCOUNTS);
        let mut name = [0u8; MAX_NAME + 12];
        let nl = d[D_NAME_LEN] as usize;
        name[..nl].copy_from_slice(&d[D_NAME..D_NAME + nl]);
        name[nl] = b' ';
        name[nl + 1] = b'#';
        let nl = nl + 2 + write_u32(&mut name[nl + 2..], id);
        let mut uri = [0u8; MAX_URI + 16];
        let ul = uri_of(d, id, &mut uri);
        let mut w = Wr(Vec::with_capacity(nl + ul + 12));
        w.b(&[20, 0]).s(&name[..nl]).s(&uri[..ul]).b(&[0, 0]); // DataState::AccountState, plugins None, external adapters None
        let ix = Instruction {
            program_id: MPL_CORE,
            accounts: vec![AccountMeta::new(key, true), AccountMeta::new(*self.collection.key, false), AccountMeta::new_readonly(*self.store.key, true),
                AccountMeta::new(*self.payer.key, true), AccountMeta::new_readonly(*owner.key, false), AccountMeta::new_readonly(MPL_CORE, false),
                AccountMeta::new_readonly(system_program::ID, false), AccountMeta::new_readonly(MPL_CORE, false)],
            data: w.0,
        };
        let idb = id.to_le_bytes();
        Ok(invoke_signed(&ix, self.all, &[&[b"Store", &[self.bump]], &[b"Asset", &d[D_CID..D_CID + 32], &idb, &[bump]]])?)
    }
}

/// TransferV1 (14): asset (w), collection, payer (w, s), authority (s), new_owner, system, log wrapper.
#[allow(clippy::too_many_arguments)]
fn core_transfer(all: &[AccountInfo], asset: &AccountInfo, col: &AccountInfo, payer: &AccountInfo, auth: &AccountInfo, to: &AccountInfo, store_bump: Option<u8>) -> R {
    let ix = Instruction {
        program_id: MPL_CORE,
        accounts: vec![AccountMeta::new(*asset.key, false), AccountMeta::new_readonly(*col.key, false), AccountMeta::new(*payer.key, true),
            AccountMeta::new_readonly(*auth.key, true), AccountMeta::new_readonly(*to.key, false), AccountMeta::new_readonly(system_program::ID, false), AccountMeta::new_readonly(MPL_CORE, false)],
        data: vec![14, 0],
    };
    match store_bump { Some(b) => invoke_signed(&ix, all, &[&[b"Store", &[b]]])?, None => invoke_signed(&ix, all, &[])? }
    Ok(())
}

/// Core AssetV1: key (1 = AssetV1) | owner (32) | ...
#[inline(never)]
fn asset_owner(a: &AccountInfo) -> R<Pubkey> {
    req!(*a.owner == MPL_CORE, E_ACCOUNTS);
    let d = dat(&a);
    req!(d.len() >= 33 && d[0] == 1, E_ACCOUNTS);
    Ok(pk(d, 1))
}

#[inline(never)]
fn write_u32(buf: &mut [u8], v: u32) -> usize {
    let mut t = [0u8; 10];
    let (mut k, mut v) = (0, v);
    loop { t[k] = b'0' + (v % 10) as u8; k += 1; v /= 10; if v == 0 { break; } }
    for i in 0..k { buf[i] = t[k - 1 - i]; }
    k
}

/// revealed: base_uri + id + ".json", else the pre-reveal uri.
#[inline(never)]
fn uri_of(d: &[u8], id: u32, out: &mut [u8; MAX_URI + 16]) -> usize {
    if d[D_FLAGS] & F_REVEALED != 0 {
        let n = d[D_BASE_LEN] as usize;
        out[..n].copy_from_slice(&d[D_BASE..D_BASE + n]);
        let n = n + write_u32(&mut out[n..], id);
        out[n..n + 5].copy_from_slice(b".json");
        n + 5
    } else {
        let n = d[D_PRE_LEN] as usize;
        out[..n].copy_from_slice(&d[D_PRE..D_PRE + n]);
        n
    }
}

// ---------------------------------------------------------------------- LayerZero
/// CPI into the endpoint: `accs[0]` is the endpoint program, the rest are the instruction's accounts in order (the Store
/// signs). Account flags come from this transaction.
#[inline(never)]
fn endpoint_cpi(endpoint: &Pubkey, store: &Pubkey, bump: u8, accs: &[AccountInfo], data: Vec<u8>) -> R {
    req!(accs[0].key == endpoint, E_ACCOUNTS);
    let ix = Instruction { program_id: *endpoint, accounts: accs[1..].iter().map(|x| meta(x, x.key == store)).collect(), data };
    Ok(invoke_signed(&ix, accs, &[&[b"Store", &[bump]]])?)
}

/// endpoint.send: accounts = endpoint program, sender (Store), then the send library accounts.
#[inline(never)]
fn send_lz(s: &St, dst: u32, receiver: &[u8; 32], msg: &[u8; MSG_LEN], opts: &[u8], native_fee: u64, accs: &[AccountInfo]) -> R {
    req!(accs.len() > 2 && *accs[1].key == s.key && accs.iter().filter(|x| *x.key == s.key).count() == 1, E_ACCOUNTS);
    let mut w = Wr(Vec::with_capacity(300));
    w.b(&EP_SEND).u32(dst).b(receiver).s(msg).s(opts).b(&native_fee.to_le_bytes()).b(&[0u8; 8]);
    endpoint_cpi(&s.endpoint, &s.key, s.bump, accs, w.0)
}

/// LayerZero type-3 options with one executor lzReceive option: gas (EVM gas units) and value (destination wei).
pub fn lz_option(gas: u64, value: u128) -> Vec<u8> {
    let mut o = Vec::with_capacity(38);
    o.extend_from_slice(&[0, 3, 1, 0, if value > 0 { 33 } else { 17 }, 1]);
    o.extend_from_slice(&(gas as u128).to_be_bytes());
    if value > 0 { o.extend_from_slice(&value.to_be_bytes()); }
    o
}

#[inline(never)]
pub fn encode_msg(kind: u8, cid: &[u8; 32], a: u64, b: u64, c: u64, to: &[u8]) -> [u8; MSG_LEN] {
    let mut m = [0u8; MSG_LEN];
    m[31] = kind;
    m[32..64].copy_from_slice(cid);
    m[88..96].copy_from_slice(&a.to_be_bytes());
    m[120..128].copy_from_slice(&b.to_be_bytes());
    m[152..160].copy_from_slice(&c.to_be_bytes());
    m[160..192].copy_from_slice(to);
    m
}

pub struct Msg { pub kind: u8, pub cid: [u8; 32], pub a: u64, pub b: u64, pub c: u64, pub to: [u8; 32] }
fn word(m: &[u8], o: usize) -> R<u64> {
    req!(m[o..o + 24].iter().all(|x| *x == 0), E_MESSAGE);
    Ok(u64::from_be_bytes([m[o + 24], m[o + 25], m[o + 26], m[o + 27], m[o + 28], m[o + 29], m[o + 30], m[o + 31]]))
}
pub fn decode_msg(m: &[u8]) -> R<Msg> {
    req!(m.len() == MSG_LEN && m[..31].iter().all(|x| *x == 0), E_MESSAGE);
    Ok(Msg { kind: m[31], cid: k32(m, 32), a: word(m, 64)?, b: word(m, 96)?, c: word(m, 128)?, to: k32(m, 160) })
}

/// LzReceiveParams: src_eid u32, sender [32], nonce u64, guid [32], message Vec<u8>, extra_data Vec<u8>
struct Lz<'a> { src: u32, sender: [u8; 32], nonce: u64, guid: [u8; 32], message: &'a [u8] }
#[inline(never)]
fn lz_params<'a>(r: &mut Rd<'a>) -> R<Lz<'a>> {
    Ok(Lz { src: r.u32(), sender: r.k(), nonce: r.u64(), guid: r.k(), message: r.s() })
}

/// Accounts the executor must pass to lz_receive for this message (returned as Vec<LzAccount>):
/// 0 payer | 1 store | 2 peer | 3 drop | 4 collection | 5 core | 6 system | 7..15 endpoint clear | then
/// CONFIRM: request, minter, assets[qty] · REJECT: request · COPY: assets[qty] · MOVE: recipient, asset
fn lz_receive_types(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    let s = store(&a[0], pid)?;
    let p = lz_params(r)?;
    let m = decode_msg(p.message)?;
    let sk = s.key.as_ref();
    let be = p.src.to_be_bytes();
    let ep = &s.endpoint;
    let mut v: Vec<u8> = Vec::with_capacity(4 + 26 * 34);
    v.extend_from_slice(&[0; 4]);
    let mut add = |k: &Pubkey, signer: bool, w: bool| { v.extend_from_slice(k.as_ref()); v.push(signer as u8); v.push(w as u8); };
    add(&Pubkey::default(), true, true);
    add(&s.key, false, false);
    add(&find(&[b"Peer", sk, &be], pid).0, false, false);
    add(&find(&[b"Drop", &m.cid], pid).0, false, true);
    add(&find(&[b"Collection", &m.cid], pid).0, false, true);
    add(&MPL_CORE, false, false);
    add(&system_program::ID, false, false);
    // endpoint clear: program, receiver, oapp registry, nonce (w), payload hash (w), endpoint settings (w), event authority, program
    add(ep, false, false);
    add(&s.key, false, false);
    add(&find(&[b"OApp", sk], ep).0, false, false);
    add(&find(&[b"Nonce", sk, &be, &p.sender], ep).0, false, true);
    add(&find(&[b"PayloadHash", sk, &be, &p.sender, &p.nonce.to_be_bytes()], ep).0, false, true);
    add(&find(&[b"Endpoint"], ep).0, false, true);
    add(&find(&[b"__event_authority"], ep).0, false, false);
    add(ep, false, false);
    let asset = |id: u64| asset_pda(&m.cid, id as u32, pid).0;
    let req_pda = |rid: u64| find(&[b"Req", &m.cid, &rid.to_le_bytes()], pid).0;
    match m.kind {
        CONFIRM => {
            add(&req_pda(m.a), false, true);
            add(&Pubkey::new_from_array(m.to), false, false);
            for k in 0..m.c.min(SOL_MAX_QTY as u64) { add(&asset(m.b + k), false, true); }
        }
        REJECT => add(&req_pda(m.a), false, true),
        COPY => { for k in 0..m.b.min(SOL_MAX_QTY as u64) { add(&asset(m.a + k), false, true); } }
        MOVE => { add(&Pubkey::new_from_array(m.to), false, false); add(&asset(m.a), false, true); }
        _ => return Err(E_MESSAGE as u64),
    }
    let n = ((v.len() - 4) / 34) as u32;
    v[..4].copy_from_slice(&n.to_le_bytes());
    set_return_data(&v);
    Ok(())
}

fn lz_receive(pid: &Pubkey, a: &[AccountInfo], r: &mut Rd) -> R {
    req!(a.len() >= 15, E_ACCOUNTS);
    let s = store(&a[1], pid)?;
    let p = lz_params(r)?;
    let m = decode_msg(p.message)?;
    let pd = peer(&a[2], pid, p.src)?;
    let (escrow, mover) = (k32(pd, P_ADDR), k32(pd, P_MOVER));
    let d = drop_acc(&a[3], pid)?;
    let from_mover = p.sender != escrow;
    req!(!from_mover || (mover != [0u8; 32] && p.sender == mover), E_SENDER);
    // endpoint.clear (accounts 7..15): verifies the payload hash and burns the nonce (no replay)
    let mut w = Wr(Vec::with_capacity(320));
    w.b(&EP_CLEAR).b(s.key.as_ref()).u32(p.src).b(&p.sender).b(&p.nonce.to_le_bytes()).b(&p.guid).s(p.message);
    endpoint_cpi(&s.endpoint, &s.key, s.bump, &a[7..15], w.0)?;
    let rest = &a[15..];
    let c = Core { all: a, collection: &a[4], payer: &a[0], store: &a[1], bump: s.bump };
    req!(d[D_CID..D_CID + 32] == m.cid && *a[4].key == pk(d, D_COLLECTION) && has_eid(d, p.src), E_PARAMS);
    // the mover (existing collections) can only release locked copies
    req!(!from_mover || (m.kind == MOVE && d[D_FLAGS] & F_EXISTING != 0), E_SENDER);
    match m.kind {
        CONFIRM => {
            // a = rid, b = start, c = qty, to = minter
            let (rid, start, qty) = (m.a, m.b as u32, m.c as u32);
            req!(qty > 0 && rest.len() == 2 + qty as usize, E_ACCOUNTS);
            let paid = {
                let q = req_acc(pid, &rest[0], &m.cid, rid)?;
                req!(q[Q_STATUS] == REQ_PENDING && g32(q, Q_QTY) == qty && start != 0, E_NOT_PENDING);
                req!(*rest[1].key == pk(q, Q_TO) && q[Q_TO..Q_TO + 32] == m.to, E_ACCOUNTS);
                q[Q_STATUS] = REQ_CONFIRMED;
                put32(q, Q_START, start);
                g64(q, Q_PAID)
            };
            let held = g64(d, D_HELD) - paid;
            put64(d, D_HELD, held);
            let pend = g32(d, D_PENDING) - qty;
            put32(d, D_PENDING, pend);
            let minted = g32(d, D_MINTED) + qty;
            put32(d, D_MINTED, minted);
            for k in 0..qty {
                let asset = &rest[2 + k as usize];
                req!(asset.data_is_empty(), E_NOT_MOVABLE); // never two copies
                c.create(pid, d, start + k, asset, &rest[1])?;
            }
        }
        REJECT => {
            req!(rest.len() == 1, E_ACCOUNTS);
            let q = req_acc(pid, &rest[0], &m.cid, m.a)?;
            req!(q[Q_STATUS] == REQ_PENDING, E_NOT_PENDING);
            q[Q_STATUS] = REQ_REFUNDED; // stays in `held` until claimed
            let pend = g32(d, D_PENDING) - g32(q, Q_QTY);
            put32(d, D_PENDING, pend);
        }
        COPY => {
            // a = start, b = qty: create the locked copies (owned by the Store) unless they exist already
            let (start, qty) = (m.a as u32, m.b as u32);
            req!(start != 0 && qty > 0 && qty <= SOL_MAX_QTY && start + qty - 1 <= g32(d, D_MAX) && rest.len() == qty as usize, E_PARAMS);
            for k in 0..qty {
                let asset = &rest[k as usize];
                if asset.data_is_empty() { c.create(pid, d, start + k, asset, &a[1])?; }
                else { req!(*asset.key == asset_pda(&m.cid, start + k, pid).0, E_ACCOUNTS); }
            }
        }
        MOVE => {
            // a = token id, to = recipient
            let id = m.a as u32;
            req!(id != 0 && id <= g32(d, D_MAX) && rest.len() == 2 && rest[0].key.as_ref() == m.to, E_PARAMS);
            let asset = &rest[1];
            if asset.data_is_empty() {
                c.create(pid, d, id, asset, &rest[0])?; // COPY not landed yet: create straight to the recipient
            } else {
                req!(*asset.key == asset_pda(&m.cid, id, pid).0, E_ACCOUNTS);
                req!(asset_owner(asset)? == s.key, E_NOT_MOVABLE); // already Active here: never two Active copies
                core_transfer(a, asset, &a[4], &a[0], &a[1], &rest[0], Some(s.bump))?;
            }
        }
        _ => return Err(E_MESSAGE as u64),
    }
    Ok(())
}

#[inline(never)]
fn req_acc<'a>(pid: &Pubkey, q: &'a AccountInfo, cid: &[u8; 32], rid: u64) -> R<&'a mut [u8; Q_LEN]> {
    let d = ours::<Q_LEN>(q, pid, T_REQ)?;
    req!(*q.key == Pubkey::create_program_address(&[b"Req", cid, &rid.to_le_bytes(), &[d[1]]], pid).map_err(|_| E_ACCOUNTS as u64)?, E_ACCOUNTS);
    Ok(d)
}
