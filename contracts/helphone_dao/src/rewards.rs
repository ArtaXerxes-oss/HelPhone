use soroban_sdk::{contract, contractimpl, Address, Env, Symbol, Vec, map, Map, i128};

#[derive(Clone)]
pub struct RewardRecord {
    pub staker: Address,
    pub amount: i128,
    pub timestamp: u64,
}

#[contract]
pub struct RewardsEngine;

#[contractimpl]
impl RewardsEngine {
    pub fn calculate_apy(total_staked: i128, annual_rewards: i128) -> i128 {
        if total_staked == 0 {
            return 0;
        }
        (annual_rewards * 10_000_000) / total_staked
    }

    pub fn calculate_user_reward(
        stake_amount: i128,
        apy_basis_points: i128,
        duration_days: u64,
    ) -> i128 {
        let daily_rate = apy_basis_points / 36_500;
        (stake_amount * daily_rate * (duration_days as i128)) / 10_000_000
    }

    pub fn disburse_rewards(
        e: &Env,
        staker: Address,
        reward_amount: i128,
        contract: Address,
    ) -> bool {
        if reward_amount <= 0 {
            return false;
        }

        let key = Symbol::new(e, "reward_disbursed");
        let mut disbursed: Map<Address, i128> = e.storage().get(&key).unwrap_or_else(|| map!(e));

        let current = disbursed.get(staker.clone()).unwrap_or(0);
        disbursed.set(staker, current + reward_amount);
        e.storage().set(&key, &disbursed);

        true
    }

    pub fn get_total_disbursed(e: &Env, staker: Address) -> i128 {
        let key = Symbol::new(e, "reward_disbursed");
        let disbursed: Map<Address, i128> = e.storage().get(&key).unwrap_or_else(|| map!(e));
        disbursed.get(staker).unwrap_or(0)
    }
}
