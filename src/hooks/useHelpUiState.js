import { useEffect, useState } from "react";

export function useHelpUiState({ loadProfile }) {
  const [mode, setMode] = useState("get");
  const [profile, setProfile] = useState(() => {
    const p = loadProfile();
    return { nickname: p.nickname || "", contact: p.contact || "" };
  });
  const [contactError, setContactError] = useState("");
  const [emergencyType, setEmergencyType] = useState(null);
  const [showEmergencyModal, setShowEmergencyModal] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try {
      return localStorage.getItem("hp_tour_done") !== "1";
    } catch {
      return true;
    }
  });
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedbackRequestId, setFeedbackRequestId] = useState(null);
  const [feedbackResponderAddress, setFeedbackResponderAddress] =
    useState(null);
  const [styleOpen, setStyleOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [showMobileForm, setShowMobileForm] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [showResolveConfirm, setShowResolveConfirm] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [selectedChar, setSelectedChar] = useState(() => {
    try {
      return localStorage.getItem("hp_selected_char") || null;
    } catch {
      return null;
    }
  });
  const [mapStyleIndex, setMapStyleIndex] = useState(0);

  useEffect(() => {
    try {
      if (selectedChar) {
        localStorage.setItem("hp_selected_char", selectedChar);
      } else {
        localStorage.removeItem("hp_selected_char");
      }
    } catch {}
  }, [selectedChar]);

  return {
    mode,
    setMode,
    profile,
    setProfile,
    contactError,
    setContactError,
    emergencyType,
    setEmergencyType,
    showEmergencyModal,
    setShowEmergencyModal,
    showOnboarding,
    setShowOnboarding,
    showFeedback,
    setShowFeedback,
    feedbackRequestId,
    setFeedbackRequestId,
    feedbackResponderAddress,
    setFeedbackResponderAddress,
    styleOpen,
    setStyleOpen,
    profileOpen,
    setProfileOpen,
    showMobileForm,
    setShowMobileForm,
    showCancelConfirm,
    setShowCancelConfirm,
    showDisconnectConfirm,
    setShowDisconnectConfirm,
    showResolveConfirm,
    setShowResolveConfirm,
    showAvatarModal,
    setShowAvatarModal,
    selectedChar,
    setSelectedChar,
    mapStyleIndex,
    setMapStyleIndex,
  };
}
