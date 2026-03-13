// Helper: go to slide mapped from chapterSegmentMap, falling back to default index
function goToMappedSlide(menuId, defaultIndex) {
    var map = window.menuToSlideIndex || {};
    var mapped = map[menuId];
    var idx = (typeof mapped === 'number' && mapped >= 0) ? mapped : defaultIndex;
    currentSlide = idx;
    clickedLink = true;
}

// Lesson Menu Links
$(function(){
    $('#menu1').on('click', function () { goToMappedSlide('menu1', 0); });  // Body Axes
    $('#menu2').on('click', function () { goToMappedSlide('menu2', 1); });  // Dorsal-Ventral
    $('#menu3').on('click', function () { goToMappedSlide('menu3', 2); });  // Lateral-Medial
    $('#menu4').on('click', function () { goToMappedSlide('menu4', 3); });  // Cranial-Caudal
    $('#menu5').on('click', function () { goToMappedSlide('menu5', 4); });  // Proximal-Distal
    $('#menu6').on('click', function () { goToMappedSlide('menu6', 5); });  // All Four Axes

    $('#menu7').on('click', function () { goToMappedSlide('menu7', 6); });  // Body Planes
    $('#menu8').on('click', function () { goToMappedSlide('menu8', 7); });  // Coronal
    $('#menu9').on('click', function () { goToMappedSlide('menu9', 8); });  // Transverse
    $('#menu10').on('click', function () { goToMappedSlide('menu10', 9); }); // Sagittal
    $('#menu11').on('click', function () { goToMappedSlide('menu11', 10); }); // Medial
    $('#menu12').on('click', function () { goToMappedSlide('menu12', 11); }); // All Four Planes

    $('#menu13').on('click', function () { goToMappedSlide('menu13', 12); }); // All Orientations
});
