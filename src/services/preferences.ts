/**
 * Preferences Service
 * Handles user preferences API calls
 */

import { api } from './api';

export interface UserPreferences {
  name?: string;
  pronouns?: string;
  gender?: string;
  emergencyContact?: string;
  medicalNotes?: string;
  [key: string]: any; // Allow for future expansion
}

export interface PreferencesResponse {
  address: string;
  preferences: UserPreferences;
  updatedAt?: number;
}

class PreferencesService {
  /**
   * Get user preferences by wallet address
   */
  async getPreferences(walletAddress: string): Promise<UserPreferences | null> {
    try {
      const response = await api.get<PreferencesResponse>(
        `/api/preferences/${walletAddress}`
      );
      
      if (response.data && response.data.preferences) {
        return response.data.preferences;
      }
      
      return null;
    } catch (error) {
      console.error('Failed to fetch preferences:', error);
      return null;
    }
  }

  /**
   * Update user preferences
   */
  async updatePreferences(
    walletAddress: string,
    preferences: Partial<UserPreferences>
  ): Promise<boolean> {
    try {
      const response = await api.post<PreferencesResponse>(
        `/api/preferences/${walletAddress}`,
        preferences
      );
      
      return response.status === 200 || response.status === 201;
    } catch (error) {
      console.error('Failed to update preferences:', error);
      return false;
    }
  }

  /**
   * Merge server preferences with local preferences
   * Used when wallet connects to sync preferences
   */
  async syncPreferences(
    walletAddress: string,
    localPreferences: UserPreferences
  ): Promise<UserPreferences> {
    const serverPreferences = await this.getPreferences(walletAddress);
    
    if (!serverPreferences) {
      // No server preferences exist, use local and save to server
      await this.updatePreferences(walletAddress, localPreferences);
      return localPreferences;
    }
    
    // Merge: server preferences take precedence
    const merged = { ...localPreferences, ...serverPreferences };
    
    // Update server with merged preferences
    await this.updatePreferences(walletAddress, merged);
    
    return merged;
  }
}

// Export singleton instance
export const preferencesService = new PreferencesService();

export default PreferencesService;