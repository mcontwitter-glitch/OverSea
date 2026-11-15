//! MultiSea omni drop + escrow on Solana.
//!
//! The Solana side of a MultiSea multichain drop. It plays the role that MultiSeaOmniDropV2 + MultiSeaOmniEscrowV2
//! play on each EVM chain, as a LayerZero V2 OApp (the `Store` PDA is the OApp) that speaks the same 192-byte
//! message format: abi.encode(uint8 kind, bytes32 collectionId, uint256 a, uint256 b, uint256 c, bytes32 to).
//!
//! - Base (EVM) stays the hub and is the only place token ids are assigned. A Solana mint is a REQUEST to the hub;
//!   the payment is held here until the hub CONFIRMs (ids minted Active to the minter) or REJECTs (claimable refund).
//! - Every NFT is a Metaplex Core asset in the drop's Core collection, at the PDA ["Asset", cid, id]. The collection
//!   carries an ENFORCED Royalties plugin (program allowlist) whose authority is this program, so nobody can lower it.
//! - Escrow copies: COPY from the hub creates the ids here as locked assets owned by the Store PDA (decided by MC:
//!   copies are created at mint, like the EVM chains, paid by the minter through the LayerZero lzReceive value).
//! - Move out: the holder's asset is locked (transferred to the Store PDA, never burned) and MOVE is sent.
//!   Move in: a locked asset is released to the recipient, or created straight to them if its COPY hasn't landed.
//! - Proceeds: withdraw() pays `fee_bps` (0.5%) of the drop's mint proceeds to the MultiSea fee recipient and the rest
//!   to the creator's payout. The fee recipient and bps are snapshotted per drop at creation (like the EVM factory).

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{keccak, program::invoke, secp256k1_recover::secp256k1_recover, system_instruction};
use mpl_core::instructions::{CreateCollectionV2CpiBuilder, TransferV1CpiBuilder, UpdateV1CpiBuilder};
use mpl_core::types::{Creator, Plugin, PluginAuthority, PluginAuthorityPair, Royalties, RuleSet};
use oapp::endpoint::{cpi::accounts::Clear, instructions::{ClearParams, RegisterOAppParams, SendParams as EpSendParams}, ConstructCPIContext};
use oapp::endpoint_cpi::LzAccount;
use oapp::LzReceiveParams;
use solana_helper::program_id_from_env;

declare_id!(Pubkey::new_from_array(program_id_from_env!("MULTISEA_OMNI_ID", "Abu55rcZKUwUvuMDbpNrHy28RF9A8PBasZa5BGGNWiA7")));

pub const STORE_SEED: &[u8] = b"Store";
pub const PEER_SEED: &[u8] = b"Peer";
pub const DROP_SEED: &[u8] = b"Drop";
pub const COLLECTION_SEED: &[u8] = b"Collection";
pub const ASSET_SEED: &[u8] = b"Asset";
pub const REQ_SEED: &[u8] = b"Req";
pub const LZ_RECEIVE_TYPES_SEED: &[u8] = oapp::LZ_RECEIVE_TYPES_SEED;

pub const MOVE: u8 = 1;
pub const REQUEST: u8 = 2;
pub const CONFIRM: u8 = 3;
pub const REJECT: u8 = 4;
pub const COPY: u8 = 5;

pub const MAX_FEE_BPS: u16 = 1500;
pub const MAX_ROYALTY_BPS: u16 = 1000;
/// Ids per mint / per COPY on Solana: every id is one account in the lzReceive transaction (tx size + compute).
/// MultiSeaOmniDropV2 applies the same cap to every chain of a drop that includes Solana.
pub const SOL_MAX_QTY: u32 = 8;
pub const MAX_EIDS: usize = 8;
pub const MAX_PHASES: usize = 8;
pub const MAX_NAME: usize = 32;
pub const MAX_URI: usize = 200;
pub const MSG_LEN: usize = 192;

/// Programs allowed to move a drop's assets (Core Royalties ProgramAllowList checks the program that owns the
/// transfer authority AND the program that owns the new owner). System = plain wallets; this program = the escrow;
/// Magic Eden (M2, M3) and Tensor (TSWAP, TCMP) = royalty-paying marketplaces.
pub fn royalty_allowlist() -> Vec<Pubkey> {
    vec![
        anchor_lang::system_program::ID,
        crate::ID,
        Pubkey::try_from("M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K").unwrap(),
        Pubkey::try_from("M3mxk5W2tt27WGT7THox7PmgRDp4m6NEhL5xvxrBfS1").unwrap(),
        Pubkey::try_from("TSWAPaqyCSx2KABk68Shruf4rp7CxcNi8hAsbdwmHbN").unwrap(),
        Pubkey::try_from("TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp").unwrap(),
    ]
}

#[program]
pub mod multisea_omni {
    use super::*;

    // ------------------------------------------------------------------ admin
    /// One-time. The payer becomes nobody special: `params.admin` (MC's wallet) is the admin and the LayerZero delegate.
    pub fn init_store(ctx: Context<InitStore>, params: InitStoreParams) -> Result<()> {
        require!(params.fee_bps <= MAX_FEE_BPS, OmniError::BadParams);
        let s = &mut ctx.accounts.store;
        s.admin = params.admin;
        s.endpoint_program = params.endpoint_program;
        s.local_eid = params.local_eid;
        s.approver = params.approver;
        s.fee_recipient = params.fee_recipient;
        s.fee_bps = params.fee_bps;
        s.move_fee = params.move_fee;
        s.gas = params.gas;
        s.bump = ctx.bumps.store;
        ctx.accounts.lz_receive_types_accounts.store = s.key();
        let seeds: &[&[u8]] = &[STORE_SEED, &[s.bump]];
        oapp::endpoint_cpi::register_oapp(
            params.endpoint_program,
            s.key(),
            ctx.remaining_accounts,
            seeds,
            RegisterOAppParams { delegate: params.admin },
        )
    }

    pub fn set_config(ctx: Context<AdminOnly>, params: SetConfigParams) -> Result<()> {
        require!(params.fee_bps <= MAX_FEE_BPS, OmniError::BadParams);
        let s = &mut ctx.accounts.store;
        s.approver = params.approver;
        s.fee_recipient = params.fee_recipient;
        s.fee_bps = params.fee_bps;
        s.move_fee = params.move_fee;
        s.gas = params.gas;
        Ok(())
    }

    pub fn transfer_admin(ctx: Context<AdminOnly>, admin: Pubkey) -> Result<()> {
        ctx.accounts.store.admin = admin;
        Ok(())
    }

    pub fn set_peer(ctx: Context<SetPeer>, eid: u32, address: [u8; 32]) -> Result<()> {
        ctx.accounts.peer.address = address;
        ctx.accounts.peer.bump = ctx.bumps.peer;
        emit!(PeerSet { eid, address });
        Ok(())
    }

    // ------------------------------------------------------------------ drops
    /// The creator creates the drop's Solana side (creator pays rent). MultiSea's approver (the same key the EVM
    /// factories trust) signs, as an EIP-191 personal message,
    /// keccak("MultiSeaSolanaDrop" | programId | creator | keccak(borsh(params)) | cid | deadline).
    pub fn create_drop(ctx: Context<CreateDrop>, cid: [u8; 32], params: DropParams, deadline: i64, sig: [u8; 64], recovery_id: u8) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(now <= deadline, OmniError::Expired);
        let store = &ctx.accounts.store;
        // approval
        let cfg = keccak::hash(&params.try_to_vec()?).0;
        let inner = keccak::hashv(&[b"MultiSeaSolanaDrop", crate::ID.as_ref(), ctx.accounts.creator.key.as_ref(), &cfg, &cid, &deadline.to_le_bytes()]).0;
        // EIP-191 personal message over the 32-byte digest, so the approver can sign from a normal wallet (signMessage raw).
        let digest = keccak::hashv(&[b"\x19Ethereum Signed Message:\n32", &inner]).0;
        let pk = secp256k1_recover(&digest, recovery_id, &sig).map_err(|_| OmniError::BadSignature)?;
        let addr = &keccak::hash(&pk.0).0[12..];
        require!(addr == store.approver, OmniError::BadSignature);
        // params
        let n = params.eids.len();
        require!(n >= 2 && n <= MAX_EIDS && !params.phases.is_empty() && params.phases.len() <= MAX_PHASES, OmniError::BadParams);
        require!(params.max_supply > 0 && params.royalty_bps <= MAX_ROYALTY_BPS, OmniError::BadParams);
        require!(params.name.len() <= MAX_NAME && params.base_uri.len() <= MAX_URI && params.pre_reveal_uri.len() <= MAX_URI, OmniError::BadParams);
        require!(params.eids.contains(&store.local_eid) && params.eids.contains(&params.hub_eid) && params.hub_eid != store.local_eid, OmniError::BadParams);
        for (i, e) in params.eids.iter().enumerate() { require!(!params.eids[..i].contains(e), OmniError::BadParams); }
        for p in params.phases.iter() {
            require!((p.end == 0 || p.end > p.start) && p.max_supply <= params.max_supply, OmniError::BadParams);
        }
        let d = &mut ctx.accounts.drop;
        d.cid = cid;
        d.owner = ctx.accounts.creator.key();
        d.payout = params.payout;
        d.collection = ctx.accounts.collection.key();
        d.fee_recipient = store.fee_recipient;
        d.fee_bps = store.fee_bps;
        d.hub_eid = params.hub_eid;
        d.max_supply = params.max_supply;
        d.royalty_bps = params.royalty_bps;
        d.revealed = params.pre_reveal_uri.is_empty();
        d.name = params.name.clone();
        d.base_uri = params.base_uri.clone();
        d.pre_reveal_uri = params.pre_reveal_uri.clone();
        d.eids = params.eids.clone();
        d.phases = params.phases.clone();
        d.bump = ctx.bumps.drop;
        d.collection_bump = ctx.bumps.collection;
        // Core collection with ENFORCED royalties; update authority + plugin authority = the Store PDA (this program).
        let store_seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
        let col_seeds: &[&[u8]] = &[COLLECTION_SEED, &cid, &[ctx.bumps.collection]];
        CreateCollectionV2CpiBuilder::new(&ctx.accounts.core_program)
            .collection(&ctx.accounts.collection)
            .update_authority(Some(&store.to_account_info()))
            .payer(&ctx.accounts.creator.to_account_info())
            .system_program(&ctx.accounts.system_program.to_account_info())
            .name(params.name.clone())
            .uri(params.collection_uri.clone())
            .plugins(vec![PluginAuthorityPair {
                plugin: Plugin::Royalties(Royalties {
                    basis_points: params.royalty_bps,
                    creators: vec![Creator { address: params.payout, percentage: 100 }],
                    rule_set: RuleSet::ProgramAllowList(royalty_allowlist()),
                }),
                authority: Some(PluginAuthority::UpdateAuthority),
            }])
            .invoke_signed(&[store_seeds, col_seeds])?;
        emit!(DropCreated { cid, drop: d.key(), collection: d.collection, creator: d.owner });
        Ok(())
    }

    /// Mint on Solana: a REQUEST to the hub (Base). The price is held in the drop until the hub answers.
    /// `hub_value` (wei) is dropped on the hub to pay its fan-out (CONFIRM back here + COPY to the other chains);
    /// remaining accounts = the LayerZero endpoint `send` accounts (the payer pays `native_fee`).
    pub fn mint<'info>(ctx: Context<'_, '_, 'info, 'info, Mint<'info>>, phase_id: u8, qty: u32, proof: Vec<[u8; 32]>, hub_value: u128, native_fee: u64) -> Result<()> {
        let d = &mut ctx.accounts.drop;
        require!(!d.paused, OmniError::Paused);
        require!(qty > 0 && qty <= SOL_MAX_QTY && (phase_id as usize) < d.phases.len(), OmniError::BadParams);
        let ph = d.phases[phase_id as usize].clone();
        let now = Clock::get()?.unix_timestamp;
        require!(now >= ph.start && (ph.end == 0 || now < ph.end), OmniError::PhaseNotActive);
        let to = ctx.accounts.minter.key();
        if ph.merkle_root != [0u8; 32] {
            let mut node = keccak::hash(&keccak::hash(to.as_ref()).0).0; // same leaf as EVM: keccak(keccak(abi.encode(bytes32 to)))
            for p in proof.iter() {
                node = if node <= *p { keccak::hashv(&[&node, p]).0 } else { keccak::hashv(&[p, &node]).0 };
            }
            require!(node == ph.merkle_root, OmniError::NotAllowlisted);
        }
        let cost = ph.price.checked_mul(qty as u64).ok_or(OmniError::BadParams)?;
        if cost > 0 {
            invoke(&system_instruction::transfer(&to, &d.key(), cost), &[ctx.accounts.minter.to_account_info(), d.to_account_info(), ctx.accounts.system_program.to_account_info()])?;
        }
        d.next_rid += 1;
        let rid = d.next_rid;
        d.held += cost;
        d.pending_qty += qty;
        let r = &mut ctx.accounts.request;
        r.to = to; r.payer = to; r.qty = qty; r.paid = cost; r.status = REQ_PENDING; r.bump = ctx.bumps.request;
        require!(r.key() == Pubkey::find_program_address(&[REQ_SEED, &d.cid, &rid.to_le_bytes()], &crate::ID).0, OmniError::BadParams);
        let msg = encode_msg(REQUEST, &d.cid, rid, qty as u64, phase_id as u64, &to.to_bytes());
        let g = &ctx.accounts.store.gas;
        let opts = lz_receive_option(g.request_base as u128 + g.request_per_id as u128 * qty as u128, hub_value);
        let hub = d.hub_eid;
        let cid = d.cid;
        send_lz(&ctx.accounts.store, &ctx.accounts.peer, hub, msg, opts, native_fee, ctx.remaining_accounts)?;
        emit!(MintRequested { cid, rid, to, qty, paid: cost });
        Ok(())
    }

    /// Escrow-held refund after a REJECT from the hub (the minter claims it; closes the request).
    pub fn claim_refund(ctx: Context<ClaimRefund>, _rid: u64) -> Result<()> {
        let r = &ctx.accounts.request;
        require!(r.status == REQ_REFUNDED, OmniError::NotPending);
        let v = r.paid;
        let d = &mut ctx.accounts.drop;
        d.held -= v;
        move_lamports(&d.to_account_info(), &ctx.accounts.payer.to_account_info(), v)?;
        Ok(())
    }

    /// Lock `token_id` here (the Store PDA becomes the holder; never burned) and make it Active for `to` on `dst_eid`.
    /// Pays the MultiSea move fee (lamports) to the fee recipient + the LayerZero fee. Remaining accounts = endpoint send.
    pub fn move_out<'info>(ctx: Context<'_, '_, 'info, 'info, MoveOut<'info>>, token_id: u32, dst_eid: u32, to: [u8; 32], native_fee: u64) -> Result<()> {
        let d = &ctx.accounts.drop;
        let store = &ctx.accounts.store;
        require!(dst_eid != store.local_eid && d.eids.contains(&dst_eid) && to != [0u8; 32], OmniError::BadParams);
        let (asset_key, _) = asset_pda(&d.cid, token_id);
        require!(ctx.accounts.asset.key() == asset_key, OmniError::BadParams);
        require!(asset_owner(&ctx.accounts.asset)? == ctx.accounts.holder.key(), OmniError::NotMovable);
        TransferV1CpiBuilder::new(&ctx.accounts.core_program)
            .asset(&ctx.accounts.asset)
            .collection(Some(&ctx.accounts.collection))
            .payer(&ctx.accounts.holder.to_account_info())
            .authority(Some(&ctx.accounts.holder.to_account_info()))
            .new_owner(&store.to_account_info())
            .system_program(Some(&ctx.accounts.system_program.to_account_info()))
            .invoke()?;
        if store.move_fee > 0 {
            invoke(&system_instruction::transfer(ctx.accounts.holder.key, ctx.accounts.fee_recipient.key, store.move_fee),
                &[ctx.accounts.holder.to_account_info(), ctx.accounts.fee_recipient.to_account_info(), ctx.accounts.system_program.to_account_info()])?;
        }
        let msg = encode_msg(MOVE, &d.cid, token_id as u64, 0, 0, &to);
        let opts = lz_receive_option(store.gas.move_gas as u128, 0);
        let cid = d.cid;
        send_lz(store, &ctx.accounts.peer, dst_eid, msg, opts, native_fee, ctx.remaining_accounts)?;
        emit!(MoveStarted { cid, token_id, from: ctx.accounts.holder.key(), dst_eid, to });
        Ok(())
    }

    /// Pays out the drop's Solana mint proceeds: fee_bps to the MultiSea fee recipient, the rest to the creator payout.
    /// Held payments (pending requests, unclaimed refunds) and the account's rent are never withdrawable.
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let d = &ctx.accounts.drop;
        let info = d.to_account_info();
        let rent = Rent::get()?.minimum_balance(info.data_len());
        let bal = info.lamports().saturating_sub(rent).saturating_sub(d.held);
        let fee = (bal as u128 * d.fee_bps as u128 / 10_000) as u64;
        if fee > 0 { move_lamports(&info, &ctx.accounts.fee_recipient.to_account_info(), fee)?; }
        if bal > fee { move_lamports(&info, &ctx.accounts.payout.to_account_info(), bal - fee)?; }
        emit!(Withdrawn { cid: d.cid, to_creator: bal - fee, to_platform: fee });
        Ok(())
    }

    pub fn set_paused(ctx: Context<DropOwner>, paused: bool) -> Result<()> { ctx.accounts.drop.paused = paused; Ok(()) }

    pub fn reveal(ctx: Context<DropOwner>, base_uri: String) -> Result<()> {
        require!(base_uri.len() <= MAX_URI, OmniError::BadParams);
        let d = &mut ctx.accounts.drop;
        d.base_uri = base_uri; d.revealed = true;
        Ok(())
    }

    /// After a reveal: point already-created assets at base_uri/<id>.json. Permissionless (it only applies the drop's URI);
    /// remaining accounts = the assets, in the same order as `ids`.
    pub fn refresh_uris<'info>(ctx: Context<'_, '_, 'info, 'info, RefreshUris<'info>>, ids: Vec<u32>) -> Result<()> {
        let d = &ctx.accounts.drop;
        require!(d.revealed && ids.len() == ctx.remaining_accounts.len(), OmniError::BadParams);
        let store_seeds: &[&[u8]] = &[STORE_SEED, &[ctx.accounts.store.bump]];
        for (i, id) in ids.iter().enumerate() {
            require!(ctx.remaining_accounts[i].key() == asset_pda(&d.cid, *id).0, OmniError::BadParams);
            UpdateV1CpiBuilder::new(&ctx.accounts.core_program)
                .asset(&ctx.remaining_accounts[i])
                .collection(Some(&ctx.accounts.collection))
                .payer(&ctx.accounts.payer.to_account_info())
                .authority(Some(&ctx.accounts.store.to_account_info()))
                .system_program(&ctx.accounts.system_program.to_account_info())
                .new_uri(d.uri_of(*id))
                .invoke_signed(&[store_seeds])?;
        }
        Ok(())
    }

    // ------------------------------------------------------------------ LayerZero receive
    pub fn lz_receive_types(ctx: Context<LzReceiveTypes>, params: LzReceiveParams) -> Result<Vec<LzAccount>> {
        lz_receive_types_impl(&ctx.accounts.store, &params)
    }

    pub fn lz_receive<'info>(ctx: Context<'_, '_, 'info, 'info, LzReceive<'info>>, params: LzReceiveParams) -> Result<()> {
        require!(params.message.len() == MSG_LEN, OmniError::BadMessage);
        let store = &ctx.accounts.store;
        let seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
        let n_clear = Clear::MIN_ACCOUNTS_LEN;
        oapp::endpoint_cpi::clear(
            store.endpoint_program,
            store.key(),
            &ctx.remaining_accounts[0..n_clear],
            seeds,
            ClearParams { receiver: store.key(), src_eid: params.src_eid, sender: params.sender, nonce: params.nonce, guid: params.guid, message: params.message.clone() },
        )?;
        let m = decode_msg(&params.message)?;
        let rest = &ctx.remaining_accounts[n_clear..];
        let d = &mut ctx.accounts.drop;
        require!(d.eids.contains(&params.src_eid), OmniError::BadParams);
        emit!(Received { guid: params.guid, cid: m.cid, kind: m.kind, src_eid: params.src_eid });
        let a = Core {
            core: &ctx.accounts.core_program, collection: &ctx.accounts.collection, payer: ctx.accounts.payer.to_account_info(),
            store: store.to_account_info(), system: ctx.accounts.system_program.to_account_info(), store_bump: store.bump,
        };
        match m.kind {
            CONFIRM => {
                // a = rid, b = start, c = qty, to = minter
                let (rid, start, qty) = (m.a, m.b as u32, m.c as u32);
                require!(rest.len() == 2 + qty as usize && qty > 0, OmniError::BadAccounts);
                let req_info = &rest[0];
                require!(req_info.key() == Pubkey::find_program_address(&[REQ_SEED, &d.cid, &rid.to_le_bytes()], &crate::ID).0 && req_info.owner == &crate::ID, OmniError::BadAccounts);
                let mut r: Account<Request> = Account::try_from(req_info)?;
                require!(r.status == REQ_PENDING && r.qty == qty && start != 0, OmniError::NotPending);
                require!(rest[1].key() == r.to && r.to.to_bytes() == m.to, OmniError::BadAccounts);
                r.status = REQ_CONFIRMED; r.start = start;
                d.held -= r.paid; d.pending_qty -= qty; d.minted_here += qty;
                r.exit(&crate::ID)?;
                for k in 0..qty {
                    let id = start + k;
                    require!(rest[2 + k as usize].data_is_empty(), OmniError::NotMovable); // never two copies
                    a.create(d, id, &rest[2 + k as usize], &rest[1])?;
                }
                emit!(MintConfirmed { cid: d.cid, rid, first_id: start, qty });
            }
            REJECT => {
                let rid = m.a;
                require!(rest.len() == 1, OmniError::BadAccounts);
                require!(rest[0].key() == Pubkey::find_program_address(&[REQ_SEED, &d.cid, &rid.to_le_bytes()], &crate::ID).0 && rest[0].owner == &crate::ID, OmniError::BadAccounts);
                let mut r: Account<Request> = Account::try_from(&rest[0])?;
                require!(r.status == REQ_PENDING, OmniError::NotPending);
                r.status = REQ_REFUNDED; d.pending_qty -= r.qty; // stays in `held` until claimed
                r.exit(&crate::ID)?;
                emit!(MintRejected { cid: d.cid, rid, reason: m.b as u8 });
            }
            COPY => {
                // a = start, b = qty: create the locked escrow copies (owned by the Store PDA) unless they exist already
                let (start, qty) = (m.a as u32, m.b as u32);
                require!(start != 0 && qty > 0 && qty <= SOL_MAX_QTY && start + qty - 1 <= d.max_supply && rest.len() == qty as usize, OmniError::BadParams);
                let mut created = 0u32;
                for k in 0..qty {
                    if rest[k as usize].data_is_empty() { a.create(d, start + k, &rest[k as usize], &a.store.clone())?; created += 1; }
                    else { require!(rest[k as usize].key() == asset_pda(&d.cid, start + k).0, OmniError::BadAccounts); }
                }
                emit!(EscrowCopies { cid: d.cid, first_id: start, qty, created });
            }
            MOVE => {
                // a = token id, to = recipient
                let id = m.a as u32;
                require!(id != 0 && id <= d.max_supply && rest.len() == 2 && rest[0].key().to_bytes() == m.to, OmniError::BadParams);
                let asset = &rest[1];
                let materialised = asset.data_is_empty();
                if materialised {
                    a.create(d, id, asset, &rest[0])?; // COPY not landed yet: create straight to the recipient
                } else {
                    require!(asset.key() == asset_pda(&d.cid, id).0, OmniError::BadAccounts);
                    require!(asset_owner(asset)? == store.key(), OmniError::NotMovable); // already Active here: never two Active copies
                    let s: &[&[u8]] = &[STORE_SEED, &[store.bump]];
                    TransferV1CpiBuilder::new(&ctx.accounts.core_program)
                        .asset(asset)
                        .collection(Some(&ctx.accounts.collection))
                        .payer(&ctx.accounts.payer.to_account_info())
                        .authority(Some(&store.to_account_info()))
                        .new_owner(&rest[0])
                        .system_program(Some(&ctx.accounts.system_program.to_account_info()))
                        .invoke_signed(&[s])?;
                }
                emit!(Released { cid: d.cid, token_id: id, to: rest[0].key(), materialised });
            }
            _ => return err!(OmniError::BadMessage),
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------- helpers
struct Core<'a, 'info> {
    core: &'a AccountInfo<'info>,
    collection: &'a AccountInfo<'info>,
    payer: AccountInfo<'info>,
    store: AccountInfo<'info>,
    system: AccountInfo<'info>,
    store_bump: u8,
}
impl<'a, 'info> Core<'a, 'info> {
    /// Create asset `id` at its PDA, in the drop's collection, owned by `owner`. The lzReceive payer (LayerZero
    /// executor, reimbursed by the lzReceive value the sender paid on the source chain) pays the rent.
    fn create(&self, d: &DropState, id: u32, asset: &AccountInfo<'info>, owner: &AccountInfo<'info>) -> Result<()> {
        let (key, bump) = asset_pda(&d.cid, id);
        require!(asset.key() == key, OmniError::BadAccounts);
        let store_seeds: &[&[u8]] = &[STORE_SEED, &[self.store_bump]];
        let idb = id.to_le_bytes();
        let asset_seeds: &[&[u8]] = &[ASSET_SEED, &d.cid, &idb, &[bump]];
        // Metaplex Core CreateV2 built by hand: the generated CPI builder borsh-serialises into two 1 KB Vecs per call, and
        // the 32 KB bump heap never frees, so 8 creates in one lzReceive would run out of memory.
        let uri = d.uri_of(id);
        let mut name_buf = [0u8; 48];
        let name_len = write_name(&mut name_buf, &d.name, id);
        let mut data = Vec::with_capacity(12 + name_len + uri.len());
        data.push(20u8); // CreateV2
        data.push(0u8);  // DataState::AccountState
        data.extend_from_slice(&(name_len as u32).to_le_bytes());
        data.extend_from_slice(&name_buf[..name_len]);
        data.extend_from_slice(&(uri.len() as u32).to_le_bytes());
        data.extend_from_slice(uri.as_bytes());
        data.push(0u8); // plugins: None (the collection's Royalties plugin applies)
        data.push(0u8); // external plugin adapters: None
        let ix = anchor_lang::solana_program::instruction::Instruction {
            program_id: mpl_core::ID,
            accounts: vec![
                AccountMeta::new(key, true),
                AccountMeta::new(self.collection.key(), false),
                AccountMeta::new_readonly(self.store.key(), true),
                AccountMeta::new(self.payer.key(), true),
                AccountMeta::new_readonly(owner.key(), false),
                AccountMeta::new_readonly(mpl_core::ID, false), // update authority: none (in a collection)
                AccountMeta::new_readonly(self.system.key(), false),
                AccountMeta::new_readonly(mpl_core::ID, false), // log wrapper: none
            ],
            data,
        };
        anchor_lang::solana_program::program::invoke_signed(
            &ix,
            &[asset.clone(), self.collection.clone(), self.store.clone(), self.payer.clone(), owner.clone(), self.core.clone(), self.system.clone()],
            &[store_seeds, asset_seeds],
        )?;
        Ok(())
    }
}

/// "<name> #<id>" into a stack buffer (no heap).
fn write_name(buf: &mut [u8; 48], name: &str, id: u32) -> usize {
    let n = name.len().min(32);
    buf[..n].copy_from_slice(&name.as_bytes()[..n]);
    buf[n] = b' '; buf[n + 1] = b'#';
    let mut digits = [0u8; 10]; let mut k = 0; let mut v = id;
    loop { digits[k] = b'0' + (v % 10) as u8; k += 1; v /= 10; if v == 0 { break; } }
    for i in 0..k { buf[n + 2 + i] = digits[k - 1 - i]; }
    n + 2 + k
}

pub fn asset_pda(cid: &[u8; 32], id: u32) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[ASSET_SEED, cid, &id.to_le_bytes()], &crate::ID)
}

/// Core AssetV1 layout: key (1 byte, 1 = AssetV1) | owner (32) | ...
fn asset_owner(a: &AccountInfo) -> Result<Pubkey> {
    require!(a.owner == &mpl_core::ID, OmniError::BadAccounts);
    let data = a.try_borrow_data()?;
    require!(data.len() >= 33 && data[0] == 1, OmniError::BadAccounts);
    Ok(Pubkey::new_from_array(data[1..33].try_into().unwrap()))
}

fn move_lamports(from: &AccountInfo, to: &AccountInfo, v: u64) -> Result<()> {
    **from.try_borrow_mut_lamports()? = from.lamports().checked_sub(v).ok_or(OmniError::BadParams)?;
    **to.try_borrow_mut_lamports()? = to.lamports().checked_add(v).ok_or(OmniError::BadParams)?;
    Ok(())
}

fn send_lz<'info>(store: &Account<'info, Store>, peer: &Account<'info, Peer>, dst_eid: u32, message: Vec<u8>, options: Vec<u8>, native_fee: u64, accounts: &[AccountInfo<'info>]) -> Result<()> {
    let seeds: &[&[u8]] = &[STORE_SEED, &[store.bump]];
    let r = oapp::endpoint_cpi::send(store.endpoint_program, store.key(), accounts, seeds,
        EpSendParams { dst_eid, receiver: peer.address, message, options, native_fee, lz_token_fee: 0 })?;
    emit!(Sent { guid: r.guid, dst_eid, nonce: r.nonce });
    Ok(())
}

/// LayerZero type-3 options with one executor lzReceive option: gas (EVM gas units) and value (destination wei).
pub fn lz_receive_option(gas: u128, value: u128) -> Vec<u8> {
    let mut o = vec![0u8, 3u8, 1u8];
    let size: u16 = if value > 0 { 33 } else { 17 };
    o.extend_from_slice(&size.to_be_bytes());
    o.push(1u8);
    o.extend_from_slice(&gas.to_be_bytes());
    if value > 0 { o.extend_from_slice(&value.to_be_bytes()); }
    o
}

pub struct Msg { pub kind: u8, pub cid: [u8; 32], pub a: u64, pub b: u64, pub c: u64, pub to: [u8; 32] }

fn word_u64(w: &[u8]) -> Result<u64> {
    require!(w[..24].iter().all(|x| *x == 0), OmniError::BadMessage);
    Ok(u64::from_be_bytes(w[24..32].try_into().unwrap()))
}
pub fn decode_msg(m: &[u8]) -> Result<Msg> {
    require!(m.len() == MSG_LEN && m[..31].iter().all(|x| *x == 0), OmniError::BadMessage);
    Ok(Msg {
        kind: m[31],
        cid: m[32..64].try_into().unwrap(),
        a: word_u64(&m[64..96])?, b: word_u64(&m[96..128])?, c: word_u64(&m[128..160])?,
        to: m[160..192].try_into().unwrap(),
    })
}
pub fn encode_msg(kind: u8, cid: &[u8; 32], a: u64, b: u64, c: u64, to: &[u8; 32]) -> Vec<u8> {
    let mut m = vec![0u8; MSG_LEN];
    m[31] = kind;
    m[32..64].copy_from_slice(cid);
    m[88..96].copy_from_slice(&a.to_be_bytes());
    m[120..128].copy_from_slice(&b.to_be_bytes());
    m[152..160].copy_from_slice(&c.to_be_bytes());
    m[160..192].copy_from_slice(to);
    m
}

/// Accounts the LayerZero executor must pass to lz_receive for this message:
/// 0 payer (executor) | 1 store | 2 peer | 3 drop | 4 collection | 5 core | 6 system | 7..15 endpoint clear | dynamic:
///   CONFIRM: request, minter, assets[qty] · REJECT: request · COPY: assets[qty] · MOVE: recipient, asset
pub fn lz_receive_types_impl(store: &Account<Store>, params: &LzReceiveParams) -> Result<Vec<LzAccount>> {
    let m = decode_msg(&params.message)?;
    let pid = crate::ID;
    let ro = |k: Pubkey| LzAccount { pubkey: k, is_signer: false, is_writable: false };
    let rw = |k: Pubkey| LzAccount { pubkey: k, is_signer: false, is_writable: true };
    let (peer, _) = Pubkey::find_program_address(&[PEER_SEED, store.key().as_ref(), &params.src_eid.to_be_bytes()], &pid);
    let (drop, _) = Pubkey::find_program_address(&[DROP_SEED, &m.cid], &pid);
    let (collection, _) = Pubkey::find_program_address(&[COLLECTION_SEED, &m.cid], &pid);
    let mut v = vec![
        LzAccount { pubkey: Pubkey::default(), is_signer: true, is_writable: true },
        ro(store.key()), ro(peer), rw(drop), rw(collection), ro(mpl_core::ID), ro(anchor_lang::system_program::ID),
    ];
    v.extend(oapp::endpoint_cpi::get_accounts_for_clear(store.endpoint_program, &store.key(), params.src_eid, &params.sender, params.nonce));
    match m.kind {
        CONFIRM => {
            v.push(rw(Pubkey::find_program_address(&[REQ_SEED, &m.cid, &m.a.to_le_bytes()], &pid).0));
            v.push(ro(Pubkey::new_from_array(m.to)));
            for k in 0..m.c.min(SOL_MAX_QTY as u64) { v.push(rw(asset_pda(&m.cid, (m.b + k) as u32).0)); }
        }
        REJECT => v.push(rw(Pubkey::find_program_address(&[REQ_SEED, &m.cid, &m.a.to_le_bytes()], &pid).0)),
        COPY => { for k in 0..m.b.min(SOL_MAX_QTY as u64) { v.push(rw(asset_pda(&m.cid, (m.a + k) as u32).0)); } }
        MOVE => { v.push(ro(Pubkey::new_from_array(m.to))); v.push(rw(asset_pda(&m.cid, m.a as u32).0)); }
        _ => return err!(OmniError::BadMessage),
    }
    Ok(v)
}

// ---------------------------------------------------------------------- state
#[derive(Clone, Copy, AnchorSerialize, AnchorDeserialize, InitSpace, Default)]
pub struct GasConfig {
    /// destination (EVM hub) lzReceive gas for a REQUEST: base + per id
    pub request_base: u64,
    pub request_per_id: u64,
    /// destination (EVM) lzReceive gas for a MOVE
    pub move_gas: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Store {
    pub admin: Pubkey,
    pub endpoint_program: Pubkey,
    pub local_eid: u32,
    pub approver: [u8; 20],
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub move_fee: u64,
    pub gas: GasConfig,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct LzReceiveTypesAccounts { pub store: Pubkey }

#[account]
#[derive(InitSpace)]
pub struct Peer { pub address: [u8; 32], pub bump: u8 }

#[derive(Clone, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct Phase {
    pub start: i64,
    pub end: i64,            // 0 = open-ended
    pub max_per_wallet: u32, // enforced on the hub, globally across chains
    pub max_supply: u32,     // enforced on the hub
    pub merkle_root: [u8; 32],
    pub price: u64,          // lamports per NFT on Solana (USD price converted at create time)
}

#[account]
#[derive(InitSpace)]
pub struct DropState {
    pub cid: [u8; 32],
    pub owner: Pubkey,
    pub payout: Pubkey,
    pub collection: Pubkey,
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub hub_eid: u32,
    pub max_supply: u32,
    pub royalty_bps: u16,
    pub minted_here: u32,
    pub pending_qty: u32,
    pub held: u64,
    pub next_rid: u64,
    pub paused: bool,
    pub revealed: bool,
    #[max_len(32)]
    pub name: String,
    #[max_len(200)]
    pub base_uri: String,
    #[max_len(200)]
    pub pre_reveal_uri: String,
    #[max_len(8)]
    pub eids: Vec<u32>,
    #[max_len(8)]
    pub phases: Vec<Phase>,
    pub bump: u8,
    pub collection_bump: u8,
}
impl DropState {
    pub fn uri_of(&self, id: u32) -> String {
        if self.revealed { format!("{}{}.json", self.base_uri, id) } else { self.pre_reveal_uri.clone() }
    }
}

pub const REQ_PENDING: u8 = 1;
pub const REQ_CONFIRMED: u8 = 2;
pub const REQ_REFUNDED: u8 = 3;

#[account]
#[derive(InitSpace)]
pub struct Request { pub to: Pubkey, pub payer: Pubkey, pub qty: u32, pub start: u32, pub paid: u64, pub status: u8, pub bump: u8 }

// ---------------------------------------------------------------------- params
#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct InitStoreParams {
    pub admin: Pubkey,
    pub endpoint_program: Pubkey,
    pub local_eid: u32,
    pub approver: [u8; 20],
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub move_fee: u64,
    pub gas: GasConfig,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct SetConfigParams {
    pub approver: [u8; 20],
    pub fee_recipient: Pubkey,
    pub fee_bps: u16,
    pub move_fee: u64,
    pub gas: GasConfig,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct DropParams {
    pub name: String,
    pub collection_uri: String,
    pub base_uri: String,
    pub pre_reveal_uri: String,
    pub payout: Pubkey,
    pub royalty_bps: u16,
    pub max_supply: u32,
    pub hub_eid: u32,
    pub eids: Vec<u32>,
    pub phases: Vec<Phase>,
}

// ---------------------------------------------------------------------- contexts
#[derive(Accounts)]
pub struct InitStore<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Store::INIT_SPACE, seeds = [STORE_SEED], bump)]
    pub store: Account<'info, Store>,
    #[account(init, payer = payer, space = 8 + LzReceiveTypesAccounts::INIT_SPACE, seeds = [LZ_RECEIVE_TYPES_SEED, store.key().as_ref()], bump)]
    pub lz_receive_types_accounts: Account<'info, LzReceiveTypesAccounts>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [STORE_SEED], bump = store.bump, has_one = admin @ OmniError::Unauthorized)]
    pub store: Account<'info, Store>,
}

#[derive(Accounts)]
#[instruction(eid: u32)]
pub struct SetPeer<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump, has_one = admin @ OmniError::Unauthorized)]
    pub store: Account<'info, Store>,
    #[account(init_if_needed, payer = admin, space = 8 + Peer::INIT_SPACE, seeds = [PEER_SEED, store.key().as_ref(), &eid.to_be_bytes()], bump)]
    pub peer: Account<'info, Peer>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(cid: [u8; 32])]
pub struct CreateDrop<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(init, payer = creator, space = 8 + DropState::INIT_SPACE, seeds = [DROP_SEED, &cid], bump)]
    pub drop: Account<'info, DropState>,
    /// CHECK: created by Metaplex Core (PDA signer)
    #[account(mut, seeds = [COLLECTION_SEED, &cid], bump)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Mint<'info> {
    #[account(mut)]
    pub minter: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(mut, seeds = [DROP_SEED, &drop.cid], bump = drop.bump)]
    pub drop: Account<'info, DropState>,
    #[account(seeds = [PEER_SEED, store.key().as_ref(), &drop.hub_eid.to_be_bytes()], bump = peer.bump)]
    pub peer: Account<'info, Peer>,
    #[account(init, payer = minter, space = 8 + Request::INIT_SPACE, seeds = [REQ_SEED, &drop.cid, &(drop.next_rid + 1).to_le_bytes()], bump)]
    pub request: Account<'info, Request>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(rid: u64)]
pub struct ClaimRefund<'info> {
    /// CHECK: receives the refund; must be the request's payer
    #[account(mut, address = request.payer)]
    pub payer: UncheckedAccount<'info>,
    #[account(mut, seeds = [DROP_SEED, &drop.cid], bump = drop.bump)]
    pub drop: Account<'info, DropState>,
    #[account(mut, close = payer, seeds = [REQ_SEED, &drop.cid, &rid.to_le_bytes()], bump = request.bump)]
    pub request: Account<'info, Request>,
}

#[derive(Accounts)]
#[instruction(token_id: u32, dst_eid: u32)]
pub struct MoveOut<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(seeds = [DROP_SEED, &drop.cid], bump = drop.bump)]
    pub drop: Account<'info, DropState>,
    #[account(seeds = [PEER_SEED, store.key().as_ref(), &dst_eid.to_be_bytes()], bump = peer.bump)]
    pub peer: Account<'info, Peer>,
    /// CHECK: Core asset, checked against its PDA and owner
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: the drop's Core collection
    #[account(mut, address = drop.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: MultiSea fee recipient
    #[account(mut, address = store.fee_recipient @ OmniError::BadAccounts)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, seeds = [DROP_SEED, &drop.cid], bump = drop.bump)]
    pub drop: Account<'info, DropState>,
    /// CHECK: snapshotted MultiSea fee recipient
    #[account(mut, address = drop.fee_recipient @ OmniError::BadAccounts)]
    pub fee_recipient: UncheckedAccount<'info>,
    /// CHECK: creator payout
    #[account(mut, address = drop.payout @ OmniError::BadAccounts)]
    pub payout: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct DropOwner<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [DROP_SEED, &drop.cid], bump = drop.bump, has_one = owner @ OmniError::Unauthorized)]
    pub drop: Account<'info, DropState>,
}

#[derive(Accounts)]
pub struct RefreshUris<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(seeds = [DROP_SEED, &drop.cid], bump = drop.bump)]
    pub drop: Account<'info, DropState>,
    /// CHECK: the drop's Core collection
    #[account(mut, address = drop.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LzReceiveTypes<'info> {
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
}

#[derive(Accounts)]
#[instruction(params: LzReceiveParams)]
pub struct LzReceive<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [STORE_SEED], bump = store.bump)]
    pub store: Account<'info, Store>,
    #[account(seeds = [PEER_SEED, store.key().as_ref(), &params.src_eid.to_be_bytes()], bump = peer.bump,
        constraint = peer.address == params.sender @ OmniError::InvalidSender)]
    pub peer: Account<'info, Peer>,
    #[account(mut, seeds = [DROP_SEED, &params.message[32..64]], bump = drop.bump)]
    pub drop: Account<'info, DropState>,
    /// CHECK: the drop's Core collection
    #[account(mut, address = drop.collection)]
    pub collection: UncheckedAccount<'info>,
    /// CHECK: Metaplex Core
    #[account(address = mpl_core::ID)]
    pub core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------- events + errors
#[event] pub struct PeerSet { pub eid: u32, pub address: [u8; 32] }
#[event] pub struct DropCreated { pub cid: [u8; 32], pub drop: Pubkey, pub collection: Pubkey, pub creator: Pubkey }
#[event] pub struct MintRequested { pub cid: [u8; 32], pub rid: u64, pub to: Pubkey, pub qty: u32, pub paid: u64 }
#[event] pub struct MintConfirmed { pub cid: [u8; 32], pub rid: u64, pub first_id: u32, pub qty: u32 }
#[event] pub struct MintRejected { pub cid: [u8; 32], pub rid: u64, pub reason: u8 }
#[event] pub struct EscrowCopies { pub cid: [u8; 32], pub first_id: u32, pub qty: u32, pub created: u32 }
#[event] pub struct MoveStarted { pub cid: [u8; 32], pub token_id: u32, pub from: Pubkey, pub dst_eid: u32, pub to: [u8; 32] }
#[event] pub struct Released { pub cid: [u8; 32], pub token_id: u32, pub to: Pubkey, pub materialised: bool }
#[event] pub struct Withdrawn { pub cid: [u8; 32], pub to_creator: u64, pub to_platform: u64 }
#[event] pub struct Received { pub guid: [u8; 32], pub cid: [u8; 32], pub kind: u8, pub src_eid: u32 }
#[event] pub struct Sent { pub guid: [u8; 32], pub dst_eid: u32, pub nonce: u64 }

#[error_code]
pub enum OmniError {
    #[msg("bad params")] BadParams,
    #[msg("bad accounts")] BadAccounts,
    #[msg("bad message")] BadMessage,
    #[msg("approval expired")] Expired,
    #[msg("bad approval signature")] BadSignature,
    #[msg("unauthorized")] Unauthorized,
    #[msg("paused")] Paused,
    #[msg("phase not active")] PhaseNotActive,
    #[msg("not allowlisted")] NotAllowlisted,
    #[msg("not pending")] NotPending,
    #[msg("not movable")] NotMovable,
    #[msg("invalid sender")] InvalidSender,
}
