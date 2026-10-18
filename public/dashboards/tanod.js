export default {
  roleName: 'Tanod',
  navHeading: 'FIELD MENU',
  description: 'Field view for assigned tasks, camera monitoring, alerts, and incident history.',
  canReport: false,
  canPublish: false,
  canAssignTasks: false,
  isAdmin: false,
  navigation: [
    ['▣', 'Live cameras', '#camera'],
    ['⚠', 'Alerts', '#alerts'],
    ['▤', 'Incidents', '#incidents'],
    ['◷', 'Announcements', '#announcementsPanel'],
    ['✓', 'My tasks', '#tasksPanel']
  ]
};
