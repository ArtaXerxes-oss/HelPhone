use soroban_sdk::{contracttype, symbol_short, Address, Env, Vec};

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub enum ProposalAction {
    TransferAdmin(Address),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[contracttype]
pub struct Proposal {
    pub id: u64,
    pub proposer: Address,
    pub action: ProposalAction,
    pub approvals: u32,
    pub executed: bool,
    pub created_at: u64,
}

fn admins_key() -> soroban_sdk::Symbol {
    symbol_short!("msadmins")
}
fn threshold_key() -> soroban_sdk::Symbol {
    symbol_short!("msthresh")
}
fn count_key() -> soroban_sdk::Symbol {
    symbol_short!("mscount")
}

pub fn initialise(env: &Env, admin: &Address) {
    let mut admins = Vec::new(env);
    admins.push_back(admin.clone());
    env.storage().instance().set(&admins_key(), &admins);
    env.storage().instance().set(&threshold_key(), &1u32);
    env.storage().instance().set(&count_key(), &0u64);
}

pub fn configure(env: &Env, admins: &Vec<Address>, threshold: u32) -> bool {
    if admins.is_empty() || threshold == 0 || threshold > admins.len() {
        return false;
    }
    env.storage().instance().set(&admins_key(), admins);
    env.storage().instance().set(&threshold_key(), &threshold);
    true
}

pub fn configuration(env: &Env) -> (Vec<Address>, u32) {
    (
        env.storage()
            .instance()
            .get(&admins_key())
            .unwrap_or(Vec::new(env)),
        env.storage().instance().get(&threshold_key()).unwrap_or(0),
    )
}

pub fn is_signer(env: &Env, signer: &Address) -> bool {
    let (admins, _) = configuration(env);
    admins.iter().any(|candidate| candidate == *signer)
}

pub fn create(env: &Env, proposer: &Address, action: ProposalAction) -> Proposal {
    let id: u64 = env.storage().instance().get(&count_key()).unwrap_or(0) + 1;
    let proposal = Proposal {
        id,
        proposer: proposer.clone(),
        action,
        approvals: 1,
        executed: false,
        created_at: env.ledger().timestamp(),
    };
    env.storage().instance().set(&count_key(), &id);
    env.storage()
        .persistent()
        .set(&(symbol_short!("msprop"), id), &proposal);
    env.storage()
        .persistent()
        .set(&(symbol_short!("msappr"), id, proposer.clone()), &true);
    proposal
}

pub fn get(env: &Env, id: u64) -> Option<Proposal> {
    env.storage()
        .persistent()
        .get(&(symbol_short!("msprop"), id))
}

pub fn approve(env: &Env, id: u64, signer: &Address) -> Option<Proposal> {
    let key = (symbol_short!("msappr"), id, signer.clone());
    if env.storage().persistent().has(&key) {
        return None;
    }
    let mut proposal = get(env, id)?;
    if proposal.executed {
        return None;
    }
    proposal.approvals += 1;
    env.storage().persistent().set(&key, &true);
    env.storage()
        .persistent()
        .set(&(symbol_short!("msprop"), id), &proposal);
    Some(proposal)
}

pub fn mark_executed(env: &Env, proposal: &mut Proposal) {
    proposal.executed = true;
    env.storage()
        .persistent()
        .set(&(symbol_short!("msprop"), proposal.id), proposal);
}
