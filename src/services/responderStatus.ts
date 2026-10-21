/**
 * Responder Status Service
 * Handles responder availability status API calls
 */

import { api } from './api';

export interface ResponderStatus {
  address: string;
  active: boolean;
  updatedAt: number | null;
}

export interface UpdateResponderStatusRequest {
  active: boolean;
}

class ResponderStatusService {
  /**
   * Get responder status by wallet address
   */
  async getStatus(walletAddress: string): Promise<ResponderStatus> {
    try {
      const response = await api.get<ResponderStatus>(
        `/api/responder-status/${walletAddress}`
      );
      
      return response.data;
    } catch (error) {
      console.error('Failed to fetch responder status:', error);
      
      // Return default status if API call fails
      return {
        address: walletAddress,
        active: true,
        updatedAt: null,
      };
    }
  }

  /**
   * Update responder status
   */
  async updateStatus(
    walletAddress: string,
    active: boolean
  ): Promise<ResponderStatus | null> {
    try {
      const response = await api.post<ResponderStatus>(
        `/api/responder-status/${walletAddress}`,
        { active }
      );
      
      return response.data;
    } catch (error) {
      console.error('Failed to update responder status:', error);
      return null;
    }
  }

  /**
   * Toggle responder status
   */
  async toggleStatus(walletAddress: string): Promise<ResponderStatus | null> {
    try {
      const currentStatus = await this.getStatus(walletAddress);
      const newActive = !currentStatus.active;
      
      return await this.updateStatus(walletAddress, newActive);
    } catch (error) {
      console.error('Failed to toggle responder status:', error);
      return null;
    }
  }

  /**
   * Check if responder is available (active)
   */
  async isAvailable(walletAddress: string): Promise<boolean> {
    const status = await this.getStatus(walletAddress);
    return status.active;
  }
}

// Export singleton instance
export const responderStatusService = new ResponderStatusService();

export default ResponderStatusService;