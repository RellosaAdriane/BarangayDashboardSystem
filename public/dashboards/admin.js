export default {
  roleName: 'Admin',
  navHeading: 'ADMIN MENU',
  description: 'Administration view for system overview, cameras, accounts, and barangay operations.',
  canReport: true,
  canPublish: true,
  canAssignTasks: true,
  isAdmin: true,
  navigation: [
    ['▣', 'Live cameras', '#camera'],
    ['\u25b6', 'Past footage', '#recordedFootage'],
    ['⚠', 'Alerts', '#alerts'],
    ['▤', 'Incidents', '#incidents'],
    ['◎', 'Camera setup', '#cameraAdminPanel'],
    ['♙', 'Account management', '#userAdminPanel'],
    ['◷', 'Events calendar', '#eventsPanel'],
    ['✓', 'Tasks', '#tasksPanel']
  ]
};
