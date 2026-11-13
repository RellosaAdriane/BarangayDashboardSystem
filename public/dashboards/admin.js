export default {
  roleName: 'Admin',
  navHeading: 'ADMIN MENU',
  description: 'Administration view for system overview, cameras, accounts, and barangay operations.',
  canReport: false,
  canPublish: true,
  canAssignTasks: true,
  isAdmin: true,
  defaultRoute: '#camera',
  navigation: [
    ['&#9786;', 'Face Management', '#faceManagementPanel'],
    ['▣', 'Live camera feed', '#camera'],
    ['&#9654;', 'Recording history', '#recordingHistoryPanel'],
    ['⚠', 'Alerts', '#alerts'],
    ['◎', 'Camera setup', '#cameraAdminPanel'],
    ['♙', 'Account management', '#userAdminPanel'],
    ['◷', 'Events calendar', '#eventsPanel'],
    ['✓', 'Tasks', '#tasksPanel']
  ]
};
